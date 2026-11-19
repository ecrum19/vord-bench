#!/usr/bin/env node
/**
 * Compute the expected results of every benchmark query directly on the unrestricted store of the full dataset.
 * Usage: node harness/ground-truth.mjs [--suite watdiv] [--force]
 * For suites whose ground truth strategy is "compute".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { jsonRowKey } from './lib/canonical.mjs';
import { fromRoot } from './lib/config.mjs';
import { groundTruthPath, loadSuite, readQueries } from './lib/suites.mjs';

/**
 * Evaluate a SELECT query on a SPARQL endpoint.
 * @param {string} endpoint
 * @param {string} query
 * @returns {Promise<{ variables: string[], keys: string[] }>}
 */
export async function evaluate(endpoint, query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }).toString(),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const results = await response.json();
  return { variables: results.head.vars, keys: results.results.bindings.map(jsonRowKey).sort() };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'watdiv' },
      force: { type: 'boolean', default: false },
    },
  });
  const config = loadSuite(values.suite);
  if (config.groundTruth.strategy !== 'compute') {
    throw new Error(`The ground truth of suite ${config.suite} is not computed (strategy ${config.groundTruth.strategy})`);
  }
  // Ground truth is computed for all instances that any preset may select.
  const queries = readQueries(config, { templates: [], instances: Number.POSITIVE_INFINITY });
  const outDir = fromRoot(config.groundTruth.dir);
  mkdirSync(outDir, { recursive: true });
  const summary = {};
  for (const { id, query } of queries) {
    const path = groundTruthPath(config, { id });
    const existing = existsSync(path) && !values.force ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    // Regenerated queries keep their ID, so the ground truth is only reused for the same query.
    if (existing?.query === query) {
      summary[id] = existing.count;
      continue;
    }
    const start = performance.now();
    const { variables, keys } = await evaluate(config.groundTruth.endpoint, query);
    writeFileSync(path, JSON.stringify({ id, query, variables, count: keys.length, keys }));
    summary[id] = keys.length;
    process.stdout.write(`${id}: ${keys.length} results (${Math.round(performance.now() - start)} ms)\n`);
  }
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
