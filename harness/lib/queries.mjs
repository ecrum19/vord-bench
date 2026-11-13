import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Split a WatDiv query file into its query instances, which are separated by blank lines.
 * @param {string} text
 * @returns {string[]}
 */
export function splitQueries(text) {
  return text.split(/\n\s*\n/u).map(query => query.trim()).filter(Boolean);
}

/**
 * Load the queries of a directory of WatDiv query files (one file per template, e.g. L1.txt).
 * @param {string} dir
 * @param {{ templates?: string[], instances?: number, counts?: Record<string, number> }} options
 *   templates: the templates to use (all if empty); instances: the number of instances per template;
 *   counts: expected result counts per query id, to prefer instances with results over empty ones.
 * @returns {{ id: string, template: string, instance: number, query: string }[]}
 */
export function loadQueries(dir, { templates, instances = 1, counts } = {}) {
  if (!existsSync(dir)) {
    throw new Error(`Query directory ${dir} does not exist; run the setup first`);
  }
  const available = readdirSync(dir)
    .filter(file => file.endsWith('.txt'))
    .map(file => file.slice(0, -4))
    .sort(compareTemplates);
  const selected = templates && templates.length > 0 ? templates : available;
  const queries = [];
  for (const template of selected) {
    if (!available.includes(template)) {
      throw new Error(`Unknown query template ${template}; available: ${available.join(', ')}`);
    }
    const instancesOfTemplate = splitQueries(readFileSync(join(dir, `${template}.txt`), 'utf8'))
      .map((query, instance) => ({ id: `${template}-${instance}`, template, instance, query }));
    if (counts) {
      // A stable sort keeps the original order within instances with and without results.
      instancesOfTemplate.sort((a, b) => Number(!counts[a.id]) - Number(!counts[b.id]));
    }
    queries.push(...instancesOfTemplate.slice(0, instances));
  }
  return queries;
}

/**
 * Order templates as WatDiv does: by class (L, S, F, C), then by number, followed by the challenge queries (X).
 */
export function compareTemplates(a, b) {
  const order = 'LSFCX';
  const classA = order.indexOf(a[0]);
  const classB = order.indexOf(b[0]);
  if (classA !== classB) {
    return classA - classB;
  }
  return Number(a.slice(1)) - Number(b.slice(1));
}
