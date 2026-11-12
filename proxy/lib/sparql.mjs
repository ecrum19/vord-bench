const PROLOGUE = /^(?:\s+|#[^\n]*\n|PREFIX\s+[\w.-]*:\s*<[^>]*>|BASE\s*<[^>]*>)*/iu;

/**
 * Determine the form of a SPARQL query.
 * @param {string} query
 * @returns {'SELECT' | 'ASK' | 'CONSTRUCT' | 'DESCRIBE' | undefined}
 */
export function getQueryForm(query) {
  const rest = query.replace(PROLOGUE, '');
  const match = /^(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/iu.exec(rest);
  return match ? match[1].toUpperCase() : undefined;
}

/**
 * The media type the proxy requests from the upstream store for a query form.
 * @param {string | undefined} form
 */
export function upstreamAccept(form) {
  return form === 'CONSTRUCT' || form === 'DESCRIBE' ? 'application/n-triples' : 'application/sparql-results+json';
}

/**
 * Count the results of a response body, and truncate them to a limit.
 * Supports SPARQL JSON results and N-Triples.
 * @param {string} body
 * @param {string} contentType
 * @param {number | undefined} limit
 * @returns {{ body: string, rows: number | undefined, truncated: boolean }}
 */
export function truncateResults(body, contentType, limit) {
  if (contentType.includes('application/sparql-results+json')) {
    const results = JSON.parse(body);
    const bindings = results.results?.bindings;
    if (!Array.isArray(bindings)) {
      // An ASK result.
      return { body, rows: undefined, truncated: false };
    }
    if (limit !== undefined && bindings.length > limit) {
      results.results.bindings = bindings.slice(0, limit);
      return { body: JSON.stringify(results), rows: limit, truncated: true };
    }
    return { body, rows: bindings.length, truncated: false };
  }
  if (contentType.includes('application/n-triples')) {
    const lines = body.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'));
    if (limit !== undefined && lines.length > limit) {
      return { body: `${lines.slice(0, limit).join('\n')}\n`, rows: limit, truncated: true };
    }
    return { body, rows: lines.length, truncated: false };
  }
  return { body, rows: undefined, truncated: false };
}
