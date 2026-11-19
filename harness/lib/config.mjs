import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Resolve a path relative to the repository root.
 * @param {string} path
 */
export function fromRoot(path) {
  return isAbsolute(path) ? path : join(ROOT, path);
}

export function readJson(path) {
  return JSON.parse(readFileSync(fromRoot(path), 'utf8'));
}

/**
 * Get the path of the generated engine manifest, and check that it exists.
 */
export function loadEngineManifest() {
  const path = fromRoot('engines/generated/manifest.json');
  if (!existsSync(path)) {
    throw new Error('No generated engines found; run "npm run generate-engines" first');
  }
  return readJson(path);
}

/**
 * Split a comma-separated command-line list.
 * @param {string | undefined} value
 * @returns {string[] | undefined}
 */
export function parseList(value) {
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : undefined;
}
