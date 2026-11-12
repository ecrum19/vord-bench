#!/usr/bin/env node
/**
 * Run a single query with a single engine, in its own process.
 * Usage: NODE_PATH=<comunica>/node_modules node harness/run-query.mjs <job.json>
 * (NODE_PATH lets the compiled engine modules in engines/generated resolve Comunica's packages.)
 *
 * The job describes the engine (compiled module or config), the sources, the query, the expected results
 * and a timeout. The run's measurements are written to job.outPath as JSON.
 * Every HTTP request is counted through a wrapped fetch function, including retries.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { ResultMatcher, bindingsKey } from './lib/canonical.mjs';

const require = createRequire(import.meta.url);

/**
 * Instantiate a Comunica engine from the fork.
 * @param {{ comunicaDir: string, compiled?: string, config: string }} job
 */
export async function createEngine(job) {
  const comunicaRequire = createRequire(join(job.comunicaDir, 'engines/query-sparql/package.json'));
  if (job.compiled) {
    const { QueryEngineBase } = comunicaRequire('@comunica/actor-init-query');
    return new QueryEngineBase(require(job.compiled)());
  }
  const { QueryEngineFactory } = comunicaRequire('./lib/QueryEngineFactory.js');
  return new QueryEngineFactory().create({ configPath: job.config });
}

/**
 * Create a fetch function that records every request.
 * @param {() => number} elapsed
 */
export function createRecordingFetch(elapsed) {
  const requests = [];
  const recordingFetch = async(input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const isQuery = url.searchParams.has('query') || Boolean(init?.body);
    const entry = { host: url.host, kind: isQuery ? 'query' : 'sd', start: elapsed() };
    requests.push(entry);
    try {
      const response = await fetch(input, init);
      entry.status = response.status;
      entry.ms = elapsed() - entry.start;
      return response;
    } catch (error) {
      // Comunica aborts requests it no longer needs, such as COUNT queries after countTimeout.
      entry.status = error.name === 'AbortError' ? 'aborted' : 'failed';
      entry.error = error.name;
      entry.ms = elapsed() - entry.start;
      throw error;
    }
  };
  return { recordingFetch, requests };
}

/**
 * Summarize recorded requests.
 * @param {object[]} requests
 */
export function summarizeRequests(requests) {
  const summary = { total: requests.length, queries: 0, serviceDescriptions: 0, byStatus: {}, byHost: {}};
  for (const request of requests) {
    if (request.kind === 'sd') {
      summary.serviceDescriptions++;
    } else {
      summary.queries++;
    }
    const status = request.status ?? 'pending';
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    summary.byHost[request.host] = (summary.byHost[request.host] ?? 0) + 1;
  }
  return summary;
}

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const expected = JSON.parse(readFileSync(job.groundTruth, 'utf8')).keys;
  const matcher = new ResultMatcher(expected);

  const engineStart = performance.now();
  const engine = await createEngine(job);
  const engineMs = performance.now() - engineStart;

  let queryStart;
  const elapsed = () => performance.now() - queryStart;
  const { recordingFetch, requests } = createRecordingFetch(elapsed);
  let ttfrMs;
  let finished = false;

  const finish = (status, error) => {
    if (finished) {
      return;
    }
    finished = true;
    const result = {
      status,
      error: error ? String(error.message ?? error).slice(0, 2_000) : undefined,
      engineMs: Math.round(engineMs),
      timeMs: Math.round(elapsed()),
      ttfrMs: ttfrMs === undefined ? undefined : Math.round(ttfrMs),
      ...matcher.summary(),
      requests: summarizeRequests(requests),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1_024),
    };
    if (job.tracePath) {
      writeFileSync(job.tracePath, requests.map(request => JSON.stringify(request)).join('\n'));
    }
    writeFileSync(job.outPath, JSON.stringify(result));
    // Pending requests and timers of the engine would keep the process alive.
    process.exit(0);
  };

  setTimeout(() => finish('timeout'), job.timeoutMs);
  queryStart = performance.now();
  try {
    const bindingsStream = await engine.queryBindings(job.query, {
      ...job.context,
      sources: job.sources,
      fetch: recordingFetch,
    });
    bindingsStream.on('data', bindings => {
      ttfrMs ??= elapsed();
      matcher.add(bindingsKey(bindings));
    });
    bindingsStream.on('error', error => finish('error', error));
    bindingsStream.on('end', () => finish('ok'));
  } catch (error) {
    finish('error', error);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });
}
