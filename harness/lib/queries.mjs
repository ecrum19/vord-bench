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
 * @param {{ templates?: string[], instances?: number }} options
 *   templates: the templates to use (all if empty); instances: the number of instances per template.
 * @returns {{ id: string, template: string, instance: number, query: string }[]}
 */
export function loadQueries(dir, { templates, instances = 1 } = {}) {
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
    const instancesOfTemplate = splitQueries(readFileSync(join(dir, `${template}.txt`), 'utf8'));
    for (let instance = 0; instance < Math.min(instances, instancesOfTemplate.length); instance++) {
      queries.push({ id: `${template}-${instance}`, template, instance, query: instancesOfTemplate[instance] });
    }
  }
  return queries;
}

/**
 * Order templates as WatDiv does: by class (L, S, F, C), then by number.
 */
export function compareTemplates(a, b) {
  const order = 'LSFC';
  const classA = order.indexOf(a[0]);
  const classB = order.indexOf(b[0]);
  if (classA !== classB) {
    return classA - classB;
  }
  return Number(a.slice(1)) - Number(b.slice(1));
}
