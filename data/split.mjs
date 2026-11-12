#!/usr/bin/env node
/**
 * Split an N-Triples dataset into partitions, by the type of each triple's subject.
 * Usage: node data/split.mjs <dataset.nt> <out-dir> [partitions.json]
 */
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUBJECT = /^<[^>]*\/([A-Za-z]+)\d*>/u;

/**
 * Create a function that maps an N-Triples line to its partition name.
 * @param {{ default: string, partitions: Record<string, string[]> }} spec
 */
export function createPartitioner(spec) {
  const byType = new Map();
  for (const [ partition, types ] of Object.entries(spec.partitions)) {
    for (const type of types) {
      byType.set(type, partition);
    }
  }
  return line => {
    const match = SUBJECT.exec(line);
    return (match && byType.get(match[1])) ?? spec.default;
  };
}

/**
 * @param {string} datasetPath
 * @param {string} outDir
 * @param {object} spec
 * @returns {Promise<Record<string, number>>} The number of triples per partition.
 */
export async function split(datasetPath, outDir, spec) {
  mkdirSync(outDir, { recursive: true });
  const partitionOf = createPartitioner(spec);
  const outputs = new Map(Object.keys(spec.partitions).map(name =>
    [ name, createWriteStream(join(outDir, `${name}.nt`)) ]));
  const counts = Object.fromEntries(Object.keys(spec.partitions).map(name => [ name, 0 ]));
  const lines = createInterface({ input: createReadStream(datasetPath), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    const partition = partitionOf(line);
    counts[partition]++;
    if (!outputs.get(partition).write(`${line}\n`)) {
      await new Promise(resolve => outputs.get(partition).once('drain', resolve));
    }
  }
  await Promise.all([ ...outputs.values() ].map(stream => new Promise(resolve => stream.end(resolve))));
  return counts;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ datasetPath, outDir, specPath = join(fileURLToPath(new URL('.', import.meta.url)), 'partitions.json') ] =
    process.argv.slice(2);
  if (!datasetPath || !outDir) {
    process.stderr.write('Usage: node data/split.mjs <dataset.nt> <out-dir> [partitions.json]\n');
    process.exit(1);
  }
  const counts = await split(datasetPath, outDir, JSON.parse(readFileSync(specPath, 'utf8')));
  writeFileSync(join(outDir, 'counts.json'), `${JSON.stringify(counts, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}
