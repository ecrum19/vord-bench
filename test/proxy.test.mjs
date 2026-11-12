import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startProxy } from '../proxy/vord-proxy.mjs';

const rate = (maxValue, windowDuration) => ({
  id: 'rate', type: 'RateRestriction', metric: 'requestsPerWindow', maxValue, windowDuration,
  enforcement: 'RejectRequest', hardRestriction: true, returnsStatusCode: 429,
});

const PROFILES = new Map([
  [ 'free', { id: 'free', restrictions: []}],
  [ 'rate', { id: 'rate', restrictions: [ rate(2, 'PT10S') ]}],
  [ 'queue', { id: 'queue', restrictions: [{ ...rate(1, 'PT0.3S'), enforcement: 'QueueRequest' }]}],
  [ 'soft', { id: 'soft', restrictions: [{ ...rate(1, 'PT10S'), hardRestriction: false }]}],
  [ 'trunc', { id: 'trunc', restrictions: [{ id: 'results', type: 'ResultSizeRestriction', maxValue: 3, enforcement: 'TruncateResult' }]}],
  [ 'conc', { id: 'conc', restrictions: [{ id: 'concurrency', type: 'ConcurrentRequestsRestriction', maxValue: 1, enforcement: 'RejectRequest', returnsStatusCode: 503 }]}],
  [ 'slow', { id: 'slow', restrictions: [{ id: 'timeout', type: 'ResponseTimeRestriction', maxValue: 0.2, enforcement: 'RejectRequest', returnsStatusCode: 503 }]}],
  [ 'mixed', { id: 'mixed', endpoints: { a: [ rate(1, 'PT10S') ]}}],
]);

/**
 * A fake SPARQL store: SELECT queries get 5 results (or LIMIT results), CONSTRUCT queries 5 triples.
 * Queries containing "SLOW" are answered after 400 ms.
 */
function createUpstream() {
  const received = [];
  const server = createServer(async(req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const query = new URLSearchParams(body).get('query');
    received.push({ query, accept: req.headers.accept });
    if (query.includes('SLOW')) {
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (query.startsWith('CONSTRUCT')) {
      res.writeHead(200, { 'content-type': 'application/n-triples' });
      return res.end([ 0, 1, 2, 3, 4 ].map(i => `<http://ex.org/s> <http://ex.org/p> <http://ex.org/o${i}> .`).join('\n'));
    }
    const limit = /LIMIT (\d+)/u.exec(query);
    const count = limit ? Number(limit[1]) : 5;
    res.writeHead(200, { 'content-type': 'application/sparql-results+json' });
    res.end(JSON.stringify({
      head: { vars: [ 'o' ]},
      results: { bindings: Array.from({ length: count }, (_, i) => ({ o: { type: 'uri', value: `http://ex.org/o${i}` }})) },
    }));
  });
  return { server, received };
}

describe('vord-proxy', () => {
  let upstream;
  let proxy;
  let base;
  let admin;

  before(async() => {
    upstream = createUpstream();
    upstream.server.listen(0, '127.0.0.1');
    await once(upstream.server, 'listening');
    const upstreamUrl = `http://127.0.0.1:${upstream.server.address().port}/query`;
    proxy = await startProxy({
      config: { adminPort: 0, endpoints: { a: { port: 0, upstream: upstreamUrl }, b: { port: 0, upstream: upstreamUrl }}},
      profiles: PROFILES,
      host: '127.0.0.1',
    });
    base = name => `http://127.0.0.1:${proxy.ports[name]}`;
    admin = `http://127.0.0.1:${proxy.ports.admin}`;
  });

  after(async() => {
    await proxy.close();
    upstream.server.closeAllConnections();
    upstream.server.close();
  });

  beforeEach(async() => {
    await fetch(`${admin}/reset?run=test`, { method: 'POST' });
  });

  const select = (endpoint, profile, query = 'SELECT ?o WHERE { ?s ?p ?o }') =>
    fetch(`${base(endpoint)}/${profile}/sparql?query=${encodeURIComponent(query)}`);

  it('serves the service description for requests without a query', async() => {
    const response = await fetch(`${base('a')}/rate/sparql`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/turtle');
    const turtle = await response.text();
    assert.match(turtle, new RegExp(`sd:endpoint <${base('a')}/rate/sparql>`, 'u'));
    assert.match(turtle, /vord:RateRestriction/u);
  });

  it('describes restrictions per endpoint', async() => {
    assert.match(await (await fetch(`${base('a')}/mixed/sparql`)).text(), /vord:RateRestriction/u);
    assert.doesNotMatch(await (await fetch(`${base('b')}/mixed/sparql`)).text(), /vord:hasRestriction/u);
  });

  it('answers unknown paths with 404', async() => {
    assert.equal((await fetch(`${base('a')}/unknown/sparql`)).status, 404);
    assert.equal((await fetch(`${base('a')}/free/other`)).status, 404);
  });

  it('forwards queries without restrictions', async() => {
    const response = await select('a', 'free');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results.bindings.length, 5);
    assert.equal(upstream.received.at(-1).accept, 'application/sparql-results+json');
  });

  it('accepts POSTed queries', async() => {
    const form = await fetch(`${base('a')}/free/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: 'SELECT ?o WHERE { ?s ?p ?o } LIMIT 2' }).toString(),
    });
    assert.equal((await form.json()).results.bindings.length, 2);
    const direct = await fetch(`${base('a')}/free/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-query' },
      body: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
    });
    assert.equal(direct.headers.get('content-type'), 'application/n-triples');
    assert.equal(upstream.received.at(-1).accept, 'application/n-triples');
    assert.equal((await fetch(`${base('a')}/free/sparql`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 400);
  });

  it('rejects requests over the rate limit with 429 and Retry-After, per endpoint', async() => {
    assert.equal((await select('a', 'rate')).status, 200);
    assert.equal((await select('a', 'rate')).status, 200);
    const rejected = await select('a', 'rate');
    assert.equal(rejected.status, 429);
    const retryAfter = Number(rejected.headers.get('retry-after'));
    assert.ok(retryAfter >= 9 && retryAfter <= 10, `Retry-After ${retryAfter}`);
    // Other endpoints have their own limits.
    assert.equal((await select('b', 'rate')).status, 200);
    // A reset clears the limits.
    await fetch(`${admin}/reset?run=test2`, { method: 'POST' });
    assert.equal((await select('a', 'rate')).status, 200);
  });

  it('queues requests over the rate limit if the enforcement is QueueRequest', async() => {
    const start = Date.now();
    const statuses = await Promise.all([ select('a', 'queue'), select('a', 'queue') ].map(async response => (await response).status));
    assert.deepEqual(statuses, [ 200, 200 ]);
    assert.ok(Date.now() - start >= 250, 'the second request waited');
  });

  it('does not enforce soft restrictions', async() => {
    assert.equal((await select('a', 'soft')).status, 200);
    assert.equal((await select('a', 'soft')).status, 200);
  });

  it('truncates results', async() => {
    const response = await select('a', 'trunc');
    assert.equal(response.headers.get('x-sparql-maxrows'), '3');
    assert.equal((await response.json()).results.bindings.length, 3);
    const triples = await fetch(`${base('a')}/trunc/sparql?query=${encodeURIComponent('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')}`);
    assert.equal((await triples.text()).trim().split('\n').length, 3);
    const small = await select('a', 'trunc', 'SELECT ?o WHERE { ?s ?p ?o } LIMIT 2');
    assert.equal(small.headers.get('x-sparql-maxrows'), null);
  });

  it('rejects requests over the concurrency limit with 503', async() => {
    const [ first, second ] = await Promise.all([
      select('a', 'conc', 'SELECT ?o WHERE { ?s ?p ?o } # SLOW'),
      new Promise(resolve => setTimeout(resolve, 100)).then(() => select('a', 'conc')),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '1');
    // The slot is released after the response.
    assert.equal((await select('a', 'conc')).status, 200);
  });

  it('rejects requests that exceed the response time', async() => {
    const response = await select('a', 'slow', 'SELECT ?o WHERE { ?s ?p ?o } # SLOW');
    assert.equal(response.status, 503);
    assert.equal((await select('a', 'slow')).status, 200);
  });

  it('reports statistics per run', async() => {
    await fetch(`${admin}/reset?run=stats`, { method: 'POST' });
    await fetch(`${base('a')}/rate/sparql`);
    await select('a', 'rate');
    await select('a', 'rate');
    await select('a', 'rate');
    await select('a', 'trunc');
    const stats = await (await fetch(`${admin}/stats?run=stats`)).json();
    assert.deepEqual(stats, {
      requests: 4, serviceDescriptions: 1, truncated: 1, byStatus: { 200: 3, 429: 1 }, byReason: { rate: 1 },
    });
    assert.deepEqual(await (await fetch(`${admin}/stats?run=none`)).json(), {
      requests: 0, serviceDescriptions: 0, truncated: 0, byStatus: {}, byReason: {},
    });
    const health = await (await fetch(`${admin}/health`)).json();
    assert.equal(health.run, 'stats');
    assert.deepEqual(health.profiles, [ ...PROFILES.keys() ]);
  });
});
