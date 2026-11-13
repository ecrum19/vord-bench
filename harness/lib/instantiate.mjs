/**
 * Instantiate WatDiv query templates with values that give results on the dataset.
 *
 * WatDiv fills the placeholders of its templates with values that are sampled independently of the data,
 * so many instances have no results at small scales.
 * The placeholders of a template are the entity constants whose value differs between its WatDiv instances;
 * constants that are equal in all instances (such as wsdbm:Role2 in S2) are part of the template.
 */

const ENTITY = /<http:\/\/db\.uwaterloo\.ca\/~galuc\/wsdbm\/[A-Za-z]+\d+>/gu;

/**
 * The quantiles (by result count) of the candidate values that are picked, in order of the instances.
 * The first instance has the median result count of all values that give results.
 */
export const QUANTILES = [ 0.5, 0.25, 0.75, 0.1, 0.9 ];

/**
 * Find the entity constants of a query, in order of their first appearance.
 * @param {string} query
 * @returns {string[]}
 */
export function findConstants(query) {
  return [ ...new Set(query.match(ENTITY) ?? []) ];
}

/**
 * Find the placeholders of a template: the constants of its first instance whose value differs between instances.
 * @param {string[]} instances The WatDiv instances of the template.
 * @returns {string[]} The placeholder values in the first instance.
 */
export function findPlaceholders(instances) {
  const occurrences = instances.map(query => query.match(ENTITY) ?? []);
  const placeholders = new Set();
  for (const [ index, constant ] of occurrences[0].entries()) {
    if (occurrences.some(constants => constants[index] !== constant)) {
      placeholders.add(constant);
    }
  }
  return [ ...placeholders ];
}

/**
 * Replace the given constants of a query by other terms.
 * @param {string} query
 * @param {string[]} constants
 * @param {string[]} terms
 */
export function replaceConstants(query, constants, terms) {
  return constants.reduce((result, constant, index) => result.split(constant).join(terms[index]), query);
}

/**
 * Create a query that counts the results of a template for every combination of values of the given constants.
 * The count includes duplicates, as the benchmark queries do not use DISTINCT.
 * @param {string} template A WatDiv SELECT query.
 * @param {string[]} constants The constants to replace by variables.
 */
export function candidateQuery(template, constants) {
  const variables = constants.map((_, index) => `?__c${index}`);
  const body = template.slice(template.indexOf('{') + 1, template.lastIndexOf('}'));
  return `SELECT ${variables.join(' ')} (COUNT(*) AS ?__n) WHERE {${replaceConstants(body, constants, variables)}}\n` +
    `GROUP BY ${variables.join(' ')}`;
}

/**
 * Pick the candidate values at the quantiles of the result counts.
 * @param {{ values: string[], count: number }[]} candidates Candidates with at least one result.
 * @param {number} instances The maximum number of instances.
 */
export function pickCandidates(candidates, instances) {
  const sorted = [ ...candidates ]
    .sort((a, b) => a.count - b.count || a.values.join(' ').localeCompare(b.values.join(' ')));
  const picked = [];
  for (const quantile of QUANTILES.slice(0, instances)) {
    const candidate = sorted[Math.round(quantile * (sorted.length - 1))];
    if (candidate && !picked.includes(candidate)) {
      picked.push(candidate);
    }
  }
  return picked;
}

/**
 * Instantiate a template so that its instances have results.
 * If no placeholder values give results, the constants of the template itself are also replaced (relaxed).
 * @param {string[]} instances The WatDiv instances of the template.
 * @param {(query: string) => Promise<{ values: string[], count: number }[]>} countCandidates
 *   Evaluates a candidate query, returning the values (IRIs) and counts of its rows.
 * @param {(query: string) => Promise<number>} countResults Counts the results of a query.
 * @param {number} instanceCount The maximum number of instances.
 * @returns {Promise<{ queries: string[], placeholders: string[], relaxed: boolean, candidates: number,
 *   picked: { values: string[], count: number }[] }>}
 */
export async function instantiateTemplate(instances, countCandidates, countResults, instanceCount) {
  const template = instances[0];
  let placeholders = findPlaceholders(instances);
  let relaxed = false;
  if (placeholders.length === 0) {
    // Templates without placeholders are used as they are, if they have results.
    const count = await countResults(template);
    if (count > 0) {
      return { queries: [ template ], placeholders, relaxed, candidates: 1, picked: [{ values: [], count }]};
    }
  }
  let candidates = placeholders.length > 0 ? await countCandidates(candidateQuery(template, placeholders)) : [];
  if (candidates.length === 0) {
    placeholders = findConstants(template);
    relaxed = true;
    candidates = placeholders.length > 0 ? await countCandidates(candidateQuery(template, placeholders)) : [];
  }
  const picked = pickCandidates(candidates, instanceCount);
  return {
    queries: picked.map(({ values }) => replaceConstants(template, placeholders, values.map(value => `<${value}>`))),
    placeholders,
    relaxed,
    candidates: candidates.length,
    picked,
  };
}
