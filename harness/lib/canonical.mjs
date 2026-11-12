const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

function literalKey(value, language, datatype) {
  if (language) {
    return `${JSON.stringify(value)}@${language.toLowerCase()}`;
  }
  if (datatype && datatype !== XSD_STRING && datatype !== RDF_LANG_STRING) {
    return `${JSON.stringify(value)}^^<${datatype}>`;
  }
  return JSON.stringify(value);
}

/**
 * A canonical string for an RDF/JS term.
 * @param {import('@rdfjs/types').Term} term
 */
export function termKey(term) {
  switch (term.termType) {
    case 'NamedNode':
      return `<${term.value}>`;
    case 'BlankNode':
      return `_:${term.value}`;
    case 'Literal':
      return literalKey(term.value, term.language, term.datatype?.value);
    default:
      return `${term.termType}:${term.value}`;
  }
}

/**
 * A canonical string for a term in SPARQL JSON results.
 * @param {{ type: string, value: string, 'xml:lang'?: string, datatype?: string }} term
 */
export function jsonTermKey(term) {
  switch (term.type) {
    case 'uri':
      return `<${term.value}>`;
    case 'bnode':
      return `_:${term.value}`;
    case 'literal':
    case 'typed-literal':
      return literalKey(term.value, term['xml:lang'], term.datatype);
    default:
      throw new Error(`Unknown SPARQL JSON term type ${term.type}`);
  }
}

function rowKey(entries) {
  return entries
    .sort(([ a ], [ b ]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([ variable, value ]) => `?${variable}=${value}`)
    .join(' ');
}

/**
 * A canonical string for a Comunica bindings object (an iterable of [variable, term]).
 * Blank nodes are not compared by label, as labels differ between engines.
 */
export function bindingsKey(bindings) {
  const entries = [];
  for (const [ variable, term ] of bindings) {
    entries.push([ variable.value, term.termType === 'BlankNode' ? '_:b' : termKey(term) ]);
  }
  return rowKey(entries);
}

/**
 * A canonical string for a row of SPARQL JSON results.
 */
export function jsonRowKey(row) {
  return rowKey(Object.entries(row).map(([ variable, term ]) =>
    [ variable, term.type === 'bnode' ? '_:b' : jsonTermKey(term) ]));
}

/**
 * Count the occurrences of each key.
 * @param {string[]} keys
 * @returns {Map<string, number>}
 */
export function toMultiset(keys) {
  const counts = new Map();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Incrementally match results against expected results (a multiset).
 */
export class ResultMatcher {
  /**
   * @param {string[]} expectedKeys
   */
  constructor(expectedKeys) {
    this.remaining = toMultiset(expectedKeys);
    this.expected = expectedKeys.length;
    this.results = 0;
    this.matched = 0;
  }

  add(key) {
    this.results++;
    const count = this.remaining.get(key);
    if (count) {
      this.matched++;
      this.remaining.set(key, count - 1);
    }
  }

  summary() {
    return {
      expected: this.expected,
      results: this.results,
      matched: this.matched,
      extra: this.results - this.matched,
      recall: this.expected === 0 ? 1 : this.matched / this.expected,
      precision: this.results === 0 ? 1 : this.matched / this.results,
    };
  }
}
