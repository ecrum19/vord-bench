#!/usr/bin/env node
/**
 * Compare the outcomes of a benchmark with a reference benchmark, per run: the regression check of a refactoring.
 * Usage: node harness/compare.mjs results/<name> results/<reference>
 *
 * Runs are matched by profile, scenario, query, engine and description mode, over all replications.
 * The outcome of a run is: complete, incomplete (fewer results, none wrong), wrong (results that are not expected),
 * timeout or error. A run agrees with the reference if the reference has the same outcome for that key in at least one
 * replication; outcomes that vary between the reference's replications are timing-dependent, and any of them counts.
 * Writes compare-<reference>.md next to runs.jsonl, prints it, and exits with 1 if any run disagrees or has no reference.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The outcome category of a run.
 * @param {object} run
 */
export function outcome(run) {
  if (run.status === 'ok') {
    if (run.precision !== undefined && run.precision < 1) {
      return 'wrong';
    }
    return run.recall === 1 ? 'complete' : 'incomplete';
  }
  return run.status === 'timeout' || run.status === 'killed' ? 'timeout' : 'error';
}

/**
 * The key of a run, without its replication.
 */
export function runKey(run) {
  return [ run.profile, run.scenario, run.query, run.engine, run.description ?? 'advertised' ].join(' / ');
}

const median = values => {
  const sorted = [ ...values ].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? undefined : sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Compare runs with reference runs.
 * @param {object[]} runs
 * @param {object[]} reference
 */
export function compareRuns(runs, reference) {
  const referenceByKey = new Map();
  for (const run of reference) {
    const key = runKey(run);
    if (!referenceByKey.has(key)) {
      referenceByKey.set(key, []);
    }
    referenceByKey.get(key).push(run);
  }
  const rows = [];
  for (const run of runs) {
    const key = runKey(run);
    const references = referenceByKey.get(key) ?? [];
    const outcomes = [ ...new Set(references.map(outcome)) ].sort();
    const own = outcome(run);
    rows.push({
      key,
      engine: run.engine,
      outcome: own,
      reference: outcomes,
      verdict: references.length === 0 ? 'missing' : outcomes.includes(own) ? 'agrees' : 'differs',
      stable: outcomes.length === 1,
      timeMs: run.timeMs,
      referenceTimeMs: median(references.filter(ref => outcome(ref) === 'complete').map(ref => ref.timeMs)),
      error: run.error,
    });
  }
  const count = verdict => rows.filter(row => row.verdict === verdict).length;
  const ratios = {};
  for (const row of rows) {
    if (row.outcome === 'complete' && row.referenceTimeMs > 0) {
      (ratios[row.engine] ??= []).push(row.timeMs / row.referenceTimeMs);
    }
  }
  return {
    rows,
    total: rows.length,
    agrees: count('agrees'),
    differs: count('differs'),
    missing: count('missing'),
    unstable: rows.filter(row => row.verdict !== 'missing' && !row.stable).length,
    timeRatio: Object.fromEntries(Object.entries(ratios).map(([ engine, values ]) => [ engine, median(values) ])),
  };
}

/**
 * Format a comparison as Markdown.
 */
export function formatComparison(name, referenceName, comparison) {
  const lines = [
    `# ${name} compared with ${referenceName}`,
    '',
    `${comparison.total} runs: ${comparison.agrees} agree, ${comparison.differs} differ, ${comparison.missing} have no reference run.`,
    `${comparison.unstable} runs have a reference whose outcome varies between replications; any of its outcomes counts as agreeing.`,
    '',
    'Median ratio of the time of complete runs to the median time of the complete reference runs, per engine:',
    '',
    '| engine | time ratio |',
    '|---|---|',
    ...Object.entries(comparison.timeRatio).map(([ engine, ratio ]) => `| ${engine} | ${ratio.toFixed(2)} |`),
    '',
  ];
  const different = comparison.rows.filter(row => row.verdict !== 'agrees');
  if (different.length > 0) {
    lines.push('## Runs that differ', '', '| run | outcome | reference outcomes | error |', '|---|---|---|---|');
    for (const row of different) {
      lines.push(`| ${row.key} | ${row.outcome} | ${row.reference.join(', ') || '-'} | ${(row.error ?? '').split('\n')[0].slice(0, 120).replaceAll('|', '\\|')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const readRuns = dir => readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ dirArg, referenceArg ] = process.argv.slice(2);
  if (!dirArg || !referenceArg) {
    process.stderr.write('Usage: node harness/compare.mjs results/<name> results/<reference>\n');
    process.exit(1);
  }
  const dir = resolve(dirArg);
  const referenceDir = resolve(referenceArg);
  const comparison = compareRuns(readRuns(dir), readRuns(referenceDir));
  const markdown = formatComparison(basename(dir), basename(referenceDir), comparison);
  writeFileSync(join(dir, `compare-${basename(referenceDir)}.md`), markdown);
  process.stdout.write(markdown);
  process.exit(comparison.differs === 0 && comparison.missing === 0 ? 0 : 1);
}
