import { scanAll } from './scanner.mjs';

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
 * Count the results of a complete response body, and truncate them to a limit.
 * Supports the formats of the streaming scanners (scanner.mjs): SPARQL JSON, XML, TSV and CSV, N-Triples and N-Quads.
 * @param {string} body
 * @param {string} contentType
 * @param {number | undefined} limit
 * @returns {{ body: string, rows: number | undefined, truncated: boolean }}
 */
export function truncateResults(body, contentType, limit) {
  return scanAll(body, contentType, limit);
}
