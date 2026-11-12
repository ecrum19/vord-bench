#!/usr/bin/env node
/**
 * Summarize the runs of a benchmark.
 * Usage: node harness/analyze.mjs results/<name>
 * Writes summary.csv, summary.md and per-query.csv next to runs.jsonl, and prints summary.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mean = values => values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
const median = values => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [ ...values ].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const statusCount = (run, status) => run.requests?.byStatus?.[status] ?? 0;

/**
 * Aggregate a group of runs.
 * A run is complete if it finished without error and returned exactly the expected results.
 * @param {object[]} runs
 */
export function aggregate(runs) {
  const ok = runs.filter(run => run.status === 'ok');
  return {
    runs: runs.length,
    failed: runs.length - ok.length,
    complete: runs.filter(run => run.status === 'ok' && run.recall === 1 && run.precision === 1).length,
    recall: mean(runs.map(run => run.recall ?? 0)),
    timeS: median(ok.map(run => run.timeMs / 1_000)),
    ttfrS: median(runs.filter(run => run.ttfrMs !== undefined).map(run => run.ttfrMs / 1_000)),
    requests: mean(runs.map(run => run.requests?.total ?? 0)),
    rejected429: mean(runs.map(run => statusCount(run, 429))),
    rejected503: mean(runs.map(run => statusCount(run, 503))),
    truncated: mean(runs.map(run => run.server?.truncated ?? 0)),
  };
}

/**
 * Group runs by the given fields, keeping the order of first appearance.
 */
export function groupBy(runs, fields) {
  const groups = new Map();
  for (const run of runs) {
    const key = fields.map(field => run[field]).join('\u0000');
    if (!groups.has(key)) {
      groups.set(key, { keys: Object.fromEntries(fields.map(field => [ field, run[field] ])), runs: []});
    }
    groups.get(key).runs.push(run);
  }
  return [ ...groups.values() ];
}

const format = value => value === undefined ? '' : Number.isInteger(value) ? String(value) : value.toFixed(2);

function toCsv(rows) {
  const columns = Object.keys(rows[0] ?? {});
  return `${[ columns.join(','), ...rows.map(row => columns.map(column => format(row[column])).join(',')) ].join('\n')}\n`;
}

function toMarkdown(rows) {
  const columns = Object.keys(rows[0] ?? {});
  return `${[
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map(row => `| ${columns.map(column => format(row[column])).join(' | ')} |`),
  ].join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? '.');
  const runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const summary = groupBy(runs, [ 'profile', 'scenario', 'engine' ])
    .map(({ keys, runs: group }) => ({ ...keys, ...aggregate(group) }));
  const perQuery = groupBy(runs, [ 'profile', 'scenario', 'engine', 'query' ])
    .map(({ keys, runs: group }) => ({ ...keys, ...aggregate(group) }));
  writeFileSync(join(dir, 'summary.csv'), toCsv(summary));
  writeFileSync(join(dir, 'per-query.csv'), toCsv(perQuery));
  const markdown = `# ${dir.split('/').pop()}\n\n${runs.length} runs. ` +
    'complete: finished without error with exactly the expected results; recall: mean over all runs; ' +
    'timeS/ttfrS: median total time and time to first result; requests, rejected429, rejected503: mean per run ' +
    '(client side, retries included); truncated: mean truncated responses per run (proxy side).\n\n' +
    toMarkdown(summary);
  writeFileSync(join(dir, 'summary.md'), markdown);
  process.stdout.write(markdown);
}
