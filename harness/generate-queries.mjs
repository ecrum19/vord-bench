#!/usr/bin/env node
/**
 * Generate the benchmark queries: WatDiv templates instantiated with values that give results,
 * and the challenge queries.
 * Usage: node harness/generate-queries.mjs [--suite watdiv] [--instances 5]
 * Reads the WatDiv queries (queries.watdivDir) and challenge queries (queries.challengeDir),
 * evaluates candidate values on the unrestricted store of the full dataset (groundTruth.endpoint),
 * and writes the queries and a manifest (instances.json) to queries.dir.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fromRoot } from './lib/config.mjs';
import { instantiateTemplate } from './lib/instantiate.mjs';
import { compareTemplates, splitQueries } from './lib/queries.mjs';
import { loadSuite } from './lib/suites.mjs';

/**
 * Evaluate a SELECT query on a SPARQL endpoint, and return its result bindings.
 * @param {string} endpoint
 * @param {string} query
 */
async function select(endpoint, query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }).toString(),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}\n${query}`);
  }
  return (await response.json()).results.bindings;
}

/**
 * Count the results of a SELECT query, including duplicates.
 * @param {string} endpoint
 * @param {string} query
 */
export async function countResults(endpoint, query) {
  const body = query.slice(query.indexOf('{') + 1, query.lastIndexOf('}'));
  const [ row ] = await select(endpoint, `SELECT (COUNT(*) AS ?n) WHERE {${body}}`);
  return Number(row.n.value);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'watdiv' },
      instances: { type: 'string', default: '5' },
    },
  });
  const config = loadSuite(values.suite);
  if (config.queries.reader !== 'watdiv') {
    throw new Error(`Suite ${config.suite} does not generate WatDiv queries`);
  }
  const endpoint = config.groundTruth.endpoint;
  const watdivDir = fromRoot(config.queries.watdivDir);
  const challengeDir = fromRoot(config.queries.challengeDir);
  const outDir = fromRoot(config.queries.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Only IRIs can replace the entity constants of a template.
  const countCandidates = async query => (await select(endpoint, query))
    .map(({ __n, ...row }) => ({
      terms: Object.keys(row).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map(variable => row[variable]),
      count: Number(__n.value),
    }))
    .filter(({ terms }) => terms.every(term => term.type === 'uri'))
    .map(({ terms, count }) => ({ values: terms.map(term => term.value), count }));
  const manifest = { generatedAt: new Date().toISOString(), endpoint, templates: {}, challenge: {}};

  const templates = readdirSync(watdivDir).filter(file => file.endsWith('.txt')).map(file => file.slice(0, -4))
    .sort(compareTemplates);
  for (const template of templates) {
    const instances = splitQueries(readFileSync(join(watdivDir, `${template}.txt`), 'utf8'));
    const start = performance.now();
    const result = await instantiateTemplate(
      instances,
      countCandidates,
      query => countResults(endpoint, query),
      Number(values.instances),
    );
    const { queries, ...entry } = result;
    manifest.templates[template] = entry;
    const time = Math.round(performance.now() - start);
    if (queries.length === 0) {
      process.stdout.write(`${template}: excluded, no results for any values (${time} ms)\n`);
      continue;
    }
    writeFileSync(join(outDir, `${template}.txt`), `${queries.join('\n\n')}\n`);
    process.stdout.write(`${template}: ${queries.length} instances with ${entry.picked.map(pick => pick.count).join(', ')} ` +
      `results, from ${entry.candidates} candidates${entry.relaxed ? ' (relaxed)' : ''} (${time} ms)\n`);
  }

  for (const file of readdirSync(challengeDir).filter(name => name.endsWith('.rq')).sort()) {
    const id = file.slice(0, -3);
    const query = readFileSync(join(challengeDir, file), 'utf8').trim();
    if (query.includes('\n\n')) {
      throw new Error(`Challenge query ${file} must not contain blank lines`);
    }
    copyFileSync(join(challengeDir, file), join(outDir, `${id}.txt`));
    const count = (await select(endpoint, query)).length;
    manifest.challenge[id] = { count };
    process.stdout.write(`${id}: challenge query with ${count} results\n`);
  }
  writeFileSync(join(outDir, 'instances.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
