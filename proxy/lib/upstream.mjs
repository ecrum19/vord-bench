import { upstreamAccept } from './sparql.mjs';

/**
 * The media type requested from an upstream for a query form: configured per upstream (by form, e.g. "SELECT"),
 * or the default, which the scanners can count and truncate.
 * @param {object} upstream A normalized upstream.
 * @param {string | undefined} form
 */
export function acceptFor(upstream, form) {
  return upstream.accept[form ?? 'SELECT'] ?? upstreamAccept(form);
}

/**
 * Build the request for an upstream.
 * @param {object} upstream A normalized upstream.
 * @param {{ query: string, form?: string, defaultGraph?: string, timeoutMs?: number }} request
 *   timeoutMs: the emulated evaluation time, passed on if the upstream accepts a timeout parameter,
 *   so that requests that the proxy aborts also stop at the upstream.
 * @returns {{ url: string, init: RequestInit, accept: string }}
 */
export function buildUpstreamRequest(upstream, { query, form, defaultGraph, timeoutMs }) {
  const accept = acceptFor(upstream, form);
  const parameters = new URLSearchParams({ query });
  if (defaultGraph) {
    parameters.append('default-graph-uri', defaultGraph);
  }
  if (timeoutMs !== undefined && upstream.timeoutParameter) {
    const value = upstream.timeoutParameter.value
      .replaceAll('{ms}', String(Math.ceil(timeoutMs)))
      .replaceAll('{s}', String(Math.ceil(timeoutMs / 1_000)));
    parameters.append(upstream.timeoutParameter.name, value);
  }
  // Configured headers come first, so that the media type always matches what the scanners expect.
  const headers = { ...upstream.headers, accept };
  if (upstream.method === 'GET') {
    const url = new URL(upstream.url);
    for (const [ name, value ] of parameters) {
      url.searchParams.append(name, value);
    }
    return { url: url.href, init: { method: 'GET', headers }, accept };
  }
  return {
    url: upstream.url,
    init: {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: parameters.toString(),
    },
    accept,
  };
}
