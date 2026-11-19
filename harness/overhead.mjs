#!/usr/bin/env node
/**
 * Measure the overhead of the proxy: the validity check "direct versus proxied under P0" (PLAN-SUITES.md, section 5).
 * Usage: node harness/overhead.mjs [--suite watdiv] [--endpoint all] [--queries 5] [--repetitions 20] [--out <file>]
 *
 * Each query is sent directly to the store of an endpoint and through the proxy without restrictions (P0-none),
 * alternating which goes first, after two unrecorded warm-up requests each. The results of both are compared as multisets.
 * The queries are those with the most results, and with the results at the quartiles, so that the scanning of large
 * responses is included.
 *
 * Pass criterion, fixed before the first measurement: every query gives identical results directly and through
 * the proxy, and the median of the paired differences (proxied minus direct) is at most 10 ms or 10% of the
 * direct median, per query.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_RUN_HEADER } from '../proxy/lib/config.mjs';
import { jsonRowKey, toMultiset } from './lib/canonical.mjs';
import { ROOT, fromRoot } from './lib/config.mjs';
import { loadSuite, readQueries } from './lib/suites.mjs';

export const CRITERION = { absoluteMs: 10, relative: 0.1 };

const median = values => {
  const sorted = [ ...values ].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Pick queries spread over the result sizes: the largest, then the quartiles.
 * @param {{ id: string }[]} queries
 * @param {Record<string, number>} counts
 * @param {number} number
 */
export function pickQueries(queries, counts, number) {
  const sorted = queries.filter(query => counts[query.id] > 0).sort((a, b) => counts[b.id] - counts[a.id]);
  const picked = [];
  for (let i = 0; i < number && i < sorted.length; i++) {
    const index = Math.round(i * (sorted.length - 1) / Math.max(1, number - 1));
    if (!picked.includes(sorted[index])) {
      picked.push(sorted[index]);
    }
  }
  return picked;
}

/**
 * Whether a query passes the criterion.
 * @param {{ identical: boolean, directMs: number, overheadMs: number }} result
 */
export function passes({ identical, directMs, overheadMs }) {
  return identical && overheadMs <= Math.max(CRITERION.absoluteMs, CRITERION.relative * directMs);
}

async function timeQuery(url, query, headers = {}) {
  const start = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json', ...headers },
    body: new URLSearchParams({ query }).toString(),
  });
  const text = await response.text();
  const ms = performance.now() - start;
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${text.slice(0, 200)}`);
  }
  return { ms, keys: JSON.parse(text).results.bindings.map(jsonRowKey) };
}

function sameMultiset(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const counts = toMultiset(a);
  for (const key of b) {
    const count = counts.get(key);
    if (!count) {
      return false;
    }
    counts.set(key, count - 1);
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'watdiv' },
      endpoint: { type: 'string', default: 'all' },
      queries: { type: 'string', default: '5' },
      repetitions: { type: 'string', default: '20' },
      out: { type: 'string' },
    },
  });
  const config = loadSuite(values.suite);
  if (config.groundTruth.strategy !== 'compute') {
    throw new Error('The overhead check needs a store that is reachable directly (the ground truth endpoint)');
  }
  const direct = config.groundTruth.endpoint;
  const proxied = `${config.proxy.baseUrl}:${config.endpoints[values.endpoint].port}/P0-none/sparql`;
  const counts = JSON.parse(readFileSync(join(fromRoot(config.groundTruth.dir), 'summary.json'), 'utf8'));
  const queries = pickQueries(readQueries(config, { templates: [], instances: 1 }), counts, Number(values.queries));
  const repetitions = Number(values.repetitions);
  const headers = { [DEFAULT_RUN_HEADER]: 'overhead-check' };
  process.stdout.write(`Direct: ${direct}\nProxied: ${proxied}\nQueries: ${queries.map(query => `${query.id} (${counts[query.id]})`).join(', ')}\n\n`);

  const results = [];
  for (const query of queries) {
    for (let i = 0; i < 2; i++) {
      await timeQuery(direct, query.query);
      await timeQuery(proxied, query.query, headers);
    }
    const directTimes = [];
    const proxiedTimes = [];
    let identical = true;
    for (let rep = 0; rep < repetitions; rep++) {
      // Alternate which goes first, so that order effects cancel out.
      const order = rep % 2 === 0 ? [ 'direct', 'proxied' ] : [ 'proxied', 'direct' ];
      const measured = {};
      for (const which of order) {
        measured[which] = which === 'direct' ? await timeQuery(direct, query.query) : await timeQuery(proxied, query.query, headers);
      }
      directTimes.push(measured.direct.ms);
      proxiedTimes.push(measured.proxied.ms);
      identical &&= sameMultiset(measured.direct.keys, measured.proxied.keys);
    }
    const result = {
      query: query.id,
      results: counts[query.id],
      identical,
      directMs: median(directTimes),
      proxiedMs: median(proxiedTimes),
      overheadMs: median(directTimes.map((ms, i) => proxiedTimes[i] - ms)),
      directTimes,
      proxiedTimes,
    };
    result.pass = passes(result);
    results.push(result);
    process.stdout.write(`${query.id}: ${result.results} results, direct ${result.directMs.toFixed(1)} ms, proxied ${result.proxiedMs.toFixed(1)} ms, ` +
      `overhead ${result.overheadMs.toFixed(1)} ms (${(100 * result.overheadMs / result.directMs).toFixed(1)}%), ` +
      `${identical ? 'identical results' : 'DIFFERENT RESULTS'}: ${result.pass ? 'pass' : 'FAIL'}\n`);
  }
  const pass = results.every(result => result.pass);
  const out = values.out ?? join(ROOT, 'results', 'overhead', `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ suite: config.suite, direct, proxied, repetitions, criterion: CRITERION, pass, results }, null, 2)}\n`);
  process.stdout.write(`\n${pass ? 'PASS' : 'FAIL'}: identical results and a median overhead of at most ` +
    `${CRITERION.absoluteMs} ms or ${CRITERION.relative * 100}% of the direct time, per query. Written to ${out}\n`);
  process.exit(pass ? 0 : 1);
}
