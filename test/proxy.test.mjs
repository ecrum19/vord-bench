import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { emptyStats, startProxy } from '../proxy/vord-proxy.mjs';

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
  [ 'reject', { id: 'reject', restrictions: [{ id: 'results', type: 'ResultSizeRestriction', maxValue: 3, enforcement: 'RejectRequest', returnsStatusCode: 413 }]}],
  [ 'conc', { id: 'conc', restrictions: [{ id: 'concurrency', type: 'ConcurrentRequestsRestriction', maxValue: 1, enforcement: 'RejectRequest', returnsStatusCode: 503 }]}],
  [ 'slow', { id: 'slow', restrictions: [{ id: 'timeout', type: 'ResponseTimeRestriction', maxValue: 0.2, enforcement: 'RejectRequest', returnsStatusCode: 503 }]}],
  [ 'mixed', { id: 'mixed', endpoints: { a: [ rate(1, 'PT10S') ]}}],
]);

/**
 * A fake SPARQL endpoint, which records the requests it receives.
 * - SELECT queries get 5 results (or LIMIT results), CONSTRUCT queries 5 triples.
 * - Queries containing "SLOW" are answered after 400 ms; "STATUS<code>" gets that status;
 *   "BIG<n>" streams n results slowly, so that the proxy can stop reading early.
 * - Requests without a query get a service description.
 */
function createUpstream() {
  const received = [];
  const server = createServer(async(req, res) => {
    const url = new URL(req.url, 'http://upstream');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(body);
    const query = params.get('query');
    const request = {
      method: req.method,
      query,
      accept: req.headers.accept,
      userAgent: req.headers['user-agent'],
      params: Object.fromEntries(params),
      closedEarly: false,
      finished: false,
    };
    received.push(request);
    res.on('close', () => {
      request.closedEarly = !res.writableEnded;
    });
    if (!query) {
      res.writeHead(200, { 'content-type': 'text/turtle' });
      return res.end('<urn:upstream> a <http://www.w3.org/ns/sparql-service-description#Service> .\n');
    }
    const status = /STATUS(\d{3})/u.exec(query);
    if (status) {
      res.writeHead(Number(status[1]), { 'content-type': 'text/plain' });
      return res.end('upstream refuses');
    }
    if (query.includes('SLOW')) {
      await sleep(400);
      if (res.destroyed) {
        return;
      }
    }
    if (query.startsWith('CONSTRUCT')) {
      res.writeHead(200, { 'content-type': 'application/n-triples' });
      return res.end([ 0, 1, 2, 3, 4 ].map(i => `<http://ex.org/s> <http://ex.org/p> <http://ex.org/o${i}> .`).join('\n'));
    }
    const big = /BIG(\d+)/u.exec(query);
    if (big) {
      res.writeHead(200, { 'content-type': 'application/sparql-results+json' });
      res.write('{"head":{"vars":["o"]},"results":{"bindings":[');
      for (let i = 0; i < Number(big[1]); i++) {
        if (res.destroyed) {
          return;
        }
        res.write(`${i > 0 ? ',' : ''}{"o":{"type":"literal","value":"${i}"}}`);
        if (i % 100 === 99) {
          await sleep(5);
        }
      }
      request.finished = true;
      return res.end(']}}');
    }
    const limit = /LIMIT (\d+)/u.exec(query);
    const count = limit ? Number(limit[1]) : 5;
    res.writeHead(200, { 'content-type': 'application/sparql-results+json' });
    request.finished = true;
    res.end(JSON.stringify({
      head: { vars: [ 'o' ]},
      results: { bindings: Array.from({ length: count }, (_, i) => ({ o: { type: 'uri', value: `http://ex.org/o${i}` }})) },
    }));
  });
  return { server, received };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Start a proxy for a test, and stop it afterwards.
 */
async function withProxy(config, test) {
  const entries = [];
  const proxy = await startProxy({ config: { adminPort: 0, ...config }, profiles: PROFILES, host: '127.0.0.1', log: entry => entries.push(entry) });
  const base = name => `http://127.0.0.1:${proxy.ports[name]}`;
  const admin = `http://127.0.0.1:${proxy.ports.admin}`;
  try {
    return await test({ base, admin, entries, proxy });
  } finally {
    await proxy.close();
  }
}

const SELECT = 'SELECT ?o WHERE { ?s ?p ?o }';
const get = (base, path, query, init) =>
  fetch(`${base}${path}${query ? `?query=${encodeURIComponent(query)}` : ''}`, init);

describe('vord-proxy', () => {
  let upstream;
  let upstreamBase;
  let proxy;
  let entries;
  let base;
  let admin;

  before(async() => {
    upstream = createUpstream();
    upstreamBase = await listen(upstream.server);
    entries = [];
    proxy = await startProxy({
      config: { adminPort: 0, endpoints: { a: { port: 0, upstream: `${upstreamBase}/query` }, b: { port: 0, upstream: `${upstreamBase}/query` }}},
      profiles: PROFILES,
      host: '127.0.0.1',
      log: entry => entries.push(entry),
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

  const select = (endpoint, profile, query = SELECT) => get(base(endpoint), `/${profile}/sparql`, query);

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
    assert.equal((await fetch(`${base('a')}/free/hidden/sparql`)).status, 404);
  });

  it('forwards queries without restrictions', async() => {
    const response = await select('a', 'free');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results.bindings.length, 5);
    assert.equal(upstream.received.at(-1).accept, 'application/sparql-results+json');
    assert.equal(upstream.received.at(-1).method, 'POST');
  });

  it('accepts POSTed queries', async() => {
    const form = await fetch(`${base('a')}/free/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: `${SELECT} LIMIT 2` }).toString(),
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

  it('rejects requests over the rate limit with 429 and Retry-After, per endpoint, without forwarding them', async() => {
    const before = upstream.received.length;
    assert.equal((await select('a', 'rate')).status, 200);
    assert.equal((await select('a', 'rate')).status, 200);
    const rejected = await select('a', 'rate');
    assert.equal(rejected.status, 429);
    assert.equal(upstream.received.length - before, 2, 'the rejected request did not reach the upstream');
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
    assert.ok(entries.at(-1).queuedMs >= 250, 'the wait is logged');
  });

  it('does not enforce soft restrictions', async() => {
    assert.equal((await select('a', 'soft')).status, 200);
    assert.equal((await select('a', 'soft')).status, 200);
  });

  it('truncates results', async() => {
    const response = await select('a', 'trunc');
    assert.equal(response.headers.get('x-sparql-maxrows'), '3');
    assert.equal((await response.json()).results.bindings.length, 3);
    const triples = await get(base('a'), '/trunc/sparql', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    assert.equal((await triples.text()).trim().split('\n').length, 3);
    const small = await select('a', 'trunc', `${SELECT} LIMIT 2`);
    assert.equal(small.headers.get('x-sparql-maxrows'), null);
    assert.equal(entries.at(-1).rows, 2);
  });

  it('stops reading the upstream response once it is truncated', async() => {
    const response = await select('a', 'trunc', `${SELECT} # BIG100000`);
    assert.equal((await response.json()).results.bindings.length, 3);
    await sleep(100);
    const request = upstream.received.at(-1);
    assert.equal(request.finished, false);
    assert.equal(request.closedEarly, true);
    assert.equal(entries.at(-1).upstream.stoppedEarly, true);
    assert.ok(entries.at(-1).upstream.bytes < 1_000_000, `read ${entries.at(-1).upstream.bytes} bytes`);
  });

  it('streams large results through without a limit', async() => {
    const response = await select('a', 'free', `${SELECT} # BIG5000`);
    const results = await response.json();
    assert.equal(results.results.bindings.length, 5_000);
    assert.equal(results.results.bindings[4_999].o.value, '4999');
    const entry = entries.at(-1);
    assert.equal(entry.rows, 5_000);
    assert.equal(entry.bytesOut, entry.upstream.bytes);
  });

  it('rejects results over a rejecting result limit with 413', async() => {
    assert.equal((await select('a', 'reject')).status, 413);
    assert.equal(entries.at(-1).reason, 'result-size');
    const small = await select('a', 'reject', `${SELECT} LIMIT 3`);
    assert.equal(small.status, 200);
    assert.equal((await small.json()).results.bindings.length, 3);
  });

  it('rejects requests over the concurrency limit with 503', async() => {
    const [ first, second ] = await Promise.all([
      select('a', 'conc', `${SELECT} # SLOW`),
      sleep(100).then(() => select('a', 'conc')),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '1');
    // The slot is released after the response.
    assert.equal((await select('a', 'conc')).status, 200);
  });

  it('rejects requests that exceed the response time', async() => {
    const response = await select('a', 'slow', `${SELECT} # SLOW`);
    assert.equal(response.status, 503);
    assert.equal(entries.at(-1).reason, 'timeout');
    assert.equal((await select('a', 'slow')).status, 200);
  });

  it('aborts the upstream request when the client goes away', async() => {
    await assert.rejects(get(base('a'), '/free/sparql', `${SELECT} # SLOW`, { signal: AbortSignal.timeout(100) }));
    await sleep(100);
    assert.equal(upstream.received.at(-1).closedEarly, true);
    assert.equal(entries.at(-1).status, 499);
    assert.equal(entries.at(-1).reason, 'client-aborted');
  });

  it('describes restrictions as a VoRD file in the provided mode, and enforces them', async() => {
    const description = await (await fetch(`${base('a')}/rate/provided/sparql`)).text();
    assert.match(description, new RegExp(`sd:endpoint <${base('a')}/rate/provided/sparql>`, 'u'));
    assert.doesNotMatch(description, /vord:hasRestriction/u);
    const file = await fetch(`${admin}/vord/rate/a.ttl`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'text/turtle');
    const turtle = await file.text();
    assert.match(turtle, /sd:endpoint <http:\/\/localhost:\d+\/rate\/provided\/sparql>/u);
    assert.match(turtle, /vord:RateRestriction/u);
    // Endpoints without restrictions under a profile have no file.
    assert.equal((await fetch(`${admin}/vord/free/a.ttl`)).status, 404);
    assert.equal((await fetch(`${admin}/vord/mixed/b.ttl`)).status, 404);
    assert.equal((await fetch(`${admin}/vord/rate/nope.ttl`)).status, 404);
    // The restrictions are enforced as in the advertised mode.
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await get(base('a'), '/rate/provided/sparql', SELECT)).status);
    }
    assert.deepEqual(statuses, [ 200, 200, 429 ]);
    assert.equal(entries.at(-1).description, 'provided');
  });

  it('describes no restrictions in the none mode', async() => {
    assert.doesNotMatch(await (await fetch(`${base('a')}/rate/none/sparql`)).text(), /vord:hasRestriction/u);
    assert.equal((await get(base('a'), '/rate/none/sparql', SELECT)).status, 200);
  });

  it('attributes requests to the run in the request header', async() => {
    await fetch(`${admin}/reset?run=global`, { method: 'POST' });
    await get(base('a'), '/free/sparql', SELECT, { headers: { 'x-vord-bench-run': 'from-header' }});
    await select('a', 'free');
    assert.equal((await (await fetch(`${admin}/stats?run=from-header`)).json()).requests, 1);
    assert.equal((await (await fetch(`${admin}/stats?run=global`)).json()).requests, 1);
    assert.equal(entries.at(-2).run, 'from-header');
  });

  it('logs the emulated and upstream outcome of every request', async() => {
    await select('a', 'trunc');
    const entry = entries.at(-1);
    assert.equal(entry.status, 200);
    assert.equal(entry.truncated, true);
    assert.equal(entry.rows, 3);
    assert.equal(entry.upstream.source, 'live');
    assert.equal(entry.upstream.status, 200);
    assert.ok(entry.upstream.bytes > entry.bytesOut);
    assert.equal(entry.bytesIn, 0);
    assert.equal(entry.queuedMs, 0);
    assert.equal(typeof entry.upstreamMs, 'number');
    assert.equal(entry.endpoint, 'a');
  });

  it('reports statistics per run', async() => {
    await fetch(`${admin}/reset?run=stats`, { method: 'POST' });
    await fetch(`${base('a')}/rate/sparql`);
    await select('a', 'rate');
    await select('a', 'rate');
    await select('a', 'rate');
    await select('a', 'trunc');
    const stats = await (await fetch(`${admin}/stats?run=stats`)).json();
    assert.equal(stats.bytesOut > 0, true);
    assert.deepEqual({ ...stats, bytesOut: 0 }, {
      ...emptyStats(), requests: 4, serviceDescriptions: 1, truncated: 1, byStatus: { 200: 3, 429: 1 }, byReason: { rate: 1 }, upstreamRequests: 3,
    });
    assert.deepEqual(await (await fetch(`${admin}/stats?run=none`)).json(), emptyStats());
    const health = await (await fetch(`${admin}/health`)).json();
    assert.equal(health.run, 'stats');
    assert.deepEqual(health.profiles, [ ...PROFILES.keys() ]);
    assert.deepEqual(health.descriptionModes, [ 'advertised', 'provided', 'none' ]);
    assert.equal(health.safety.tripped, false);
  });

  it('starts a run with fresh statistics if its ID was used before', async() => {
    await fetch(`${admin}/reset?run=again`, { method: 'POST' });
    await select('a', 'rate');
    await fetch(`${admin}/reset?run=again`, { method: 'POST' });
    assert.deepEqual(await (await fetch(`${admin}/stats?run=again`)).json(), emptyStats());
  });

  describe('with configured upstreams', () => {
    const remote = (safety, extra = {}) => ({
      url: `${upstreamBase}/query`,
      method: 'GET',
      headers: { 'User-Agent': 'vord-bench-test/1.0 (+https://example.org/vord-bench)' },
      ...safety ? { safety } : {},
      ...extra,
    });
    const members = { g1: { port: 0, upstream: 'remote', defaultGraph: 'http://ex.org/g1' }, g2: { port: 0, upstream: 'remote' }};

    it('queries upstreams with GET, headers, a default graph and a timeout parameter', () => withProxy({
      upstreams: { remote: remote(undefined, { timeoutParameter: { name: 'timeout', value: '{s}s' }}) },
      endpoints: members,
    }, async({ base: proxyBase }) => {
      assert.equal((await get(proxyBase('g1'), '/slow/sparql', SELECT)).status, 200);
      const request = upstream.received.at(-1);
      assert.equal(request.method, 'GET');
      assert.equal(request.userAgent, 'vord-bench-test/1.0 (+https://example.org/vord-bench)');
      assert.equal(request.params['default-graph-uri'], 'http://ex.org/g1');
      assert.equal(request.params.timeout, '1s');
      assert.equal(request.accept, 'application/sparql-results+json');
      await get(proxyBase('g2'), '/free/sparql', SELECT);
      assert.deepEqual(Object.keys(upstream.received.at(-1).params), [ 'query' ]);
    }));

    it('passes the upstream service description through if configured', () => withProxy({
      upstreams: { remote: remote(undefined, { serviceDescription: 'passthrough' }) },
      endpoints: members,
    }, async({ base: proxyBase }) => {
      assert.match(await (await fetch(`${proxyBase('g1')}/rate/provided/sparql`)).text(), /<urn:upstream>/u);
      // The advertised mode still describes the emulated restrictions.
      assert.match(await (await fetch(`${proxyBase('g1')}/rate/sparql`)).text(), /vord:RateRestriction/u);
    }));

    it('refuses requests beyond the budget, shared by the members of a host', () => withProxy({
      upstreams: { remote: remote({ budget: 2 }) },
      endpoints: members,
    }, async({ base: proxyBase, admin: proxyAdmin, entries: logged }) => {
      const before = upstream.received.length;
      assert.equal((await get(proxyBase('g1'), '/free/sparql', SELECT)).status, 200);
      assert.equal((await get(proxyBase('g2'), '/free/sparql', SELECT)).status, 200);
      const refused = await get(proxyBase('g1'), '/free/sparql', SELECT);
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('x-vord-proxy-safety'), 'budget');
      assert.equal(upstream.received.length - before, 2);
      assert.equal(logged.at(-1).reason, 'safety-budget');
      const stats = await (await fetch(`${proxyAdmin}/stats`)).json();
      assert.equal(stats.safety, 1);
      const status = await (await fetch(`${proxyAdmin}/safety`)).json();
      assert.equal(Object.values(status.hosts)[0].used, 2);
    }));

    it('opens the breaker after repeated upstream errors, until it is closed', () => withProxy({
      upstreams: { remote: remote({ breaker: { threshold: 2 }}) },
      endpoints: members,
    }, async({ base: proxyBase, admin: proxyAdmin }) => {
      assert.equal((await get(proxyBase('g1'), '/free/sparql', `${SELECT} # STATUS403`)).status, 403);
      assert.equal((await get(proxyBase('g1'), '/free/sparql', `${SELECT} # STATUS503`)).status, 503);
      const before = upstream.received.length;
      const refused = await get(proxyBase('g2'), '/free/sparql', SELECT);
      assert.equal(refused.headers.get('x-vord-proxy-safety'), 'breaker');
      assert.equal(upstream.received.length, before);
      assert.equal((await (await fetch(`${proxyAdmin}/health`)).json()).safety.tripped, true);
      const closed = await (await fetch(`${proxyAdmin}/safety/close`, { method: 'POST' })).json();
      assert.equal(closed.closed, 1);
      assert.equal((await get(proxyBase('g2'), '/free/sparql', SELECT)).status, 200);
    }));

    it('stops all upstream requests with the kill switch, until resumed', () => withProxy({
      upstreams: { remote: remote({}) },
      endpoints: members,
    }, async({ base: proxyBase, admin: proxyAdmin, entries: logged }) => {
      const pending = get(proxyBase('g1'), '/free/sparql', `${SELECT} # SLOW`);
      await sleep(100);
      await fetch(`${proxyAdmin}/safety/kill`, { method: 'POST' });
      assert.equal((await pending).status, 503);
      assert.equal(logged.at(-1).reason, 'safety-killed');
      const refused = await get(proxyBase('g1'), '/free/sparql', SELECT);
      assert.equal(refused.headers.get('x-vord-proxy-safety'), 'killed');
      await fetch(`${proxyAdmin}/safety/resume`, { method: 'POST' });
      assert.equal((await get(proxyBase('g1'), '/free/sparql', SELECT)).status, 200);
    }));

    it('delays requests over the safety rate, and refuses them if the wait is too long', async() => {
      await withProxy({
        upstreams: { remote: remote({ rate: { maxValue: 1, windowDuration: 'PT0.3S' }}) },
        endpoints: members,
      }, async({ base: proxyBase, entries: logged }) => {
        assert.equal((await get(proxyBase('g1'), '/free/sparql', SELECT)).status, 200);
        assert.equal((await get(proxyBase('g2'), '/free/sparql', SELECT)).status, 200);
        assert.ok(logged.at(-1).safetyWaitMs >= 250, `waited ${logged.at(-1).safetyWaitMs} ms`);
      });
      await withProxy({
        upstreams: { remote: remote({ rate: { maxValue: 1, windowDuration: 'PT10S' }, maxWaitMs: 100 }) },
        endpoints: members,
      }, async({ base: proxyBase }) => {
        assert.equal((await get(proxyBase('g1'), '/free/sparql', SELECT)).status, 200);
        const refused = await get(proxyBase('g1'), '/free/sparql', SELECT);
        assert.equal(refused.headers.get('x-vord-proxy-safety'), 'rate');
      });
    });

    it('counts the requests that the published policy would refuse', () => withProxy({
      upstreams: { remote: remote(undefined, { policy: { source: 'test', restrictions: [ rate(1, 'PT10S') ]}}) },
      endpoints: members,
    }, async({ base: proxyBase, admin: proxyAdmin, entries: logged }) => {
      await fetch(`${proxyAdmin}/reset?run=polite`, { method: 'POST' });
      await get(proxyBase('g1'), '/free/sparql', SELECT);
      await get(proxyBase('g2'), '/free/sparql', SELECT);
      // Requests that the emulation rejects still count: the client sent them.
      await get(proxyBase('g2'), '/rate/sparql', SELECT);
      assert.deepEqual(logged.map(entry => entry.policy), [ undefined, [ 'rate' ], [ 'rate' ]]);
      assert.equal((await (await fetch(`${proxyAdmin}/stats?run=polite`)).json()).policyViolations, 2);
      // Every run starts with a fresh policy state.
      await fetch(`${proxyAdmin}/reset?run=polite2`, { method: 'POST' });
      await get(proxyBase('g1'), '/free/sparql', SELECT);
      assert.equal(logged.at(-1).policy, undefined);
    }));

    it('records upstream responses and replays them without contacting the upstream', async() => {
      const dir = mkdtempSync(join(tmpdir(), 'vord-proxy-recordings-'));
      const query = `${SELECT} LIMIT 4`;
      let recordedBody;
      await withProxy({
        upstreams: { remote: remote() },
        endpoints: members,
        recording: { mode: 'record', dir },
      }, async({ base: proxyBase }) => {
        recordedBody = await (await get(proxyBase('g1'), '/free/sparql', query)).text();
      });
      assert.equal(readdirSync(join(dir, 'g1')).length, 1);
      await withProxy({
        upstreams: { remote: remote() },
        endpoints: members,
        recording: { mode: 'replay', dir },
      }, async({ base: proxyBase, entries: logged, admin: proxyAdmin }) => {
        const before = upstream.received.length;
        assert.equal(await (await get(proxyBase('g1'), '/free/sparql', query)).text(), recordedBody);
        assert.equal(upstream.received.length, before, 'the replay did not contact the upstream');
        assert.equal(logged.at(-1).upstream.source, 'replay');
        // Emulated restrictions apply to replayed responses too.
        const truncated = await get(proxyBase('g1'), '/trunc/sparql', query);
        assert.equal((await truncated.json()).results.bindings.length, 3);
        // A miss is forwarded and recorded.
        await get(proxyBase('g1'), '/free/sparql', `${SELECT} LIMIT 1`);
        assert.equal(upstream.received.length, before + 1);
        assert.equal(logged.at(-1).upstream.source, 'live');
        assert.equal(readdirSync(join(dir, 'g1')).length, 2);
        const health = await (await fetch(`${proxyAdmin}/health`)).json();
        assert.equal(health.recording.hits, 2);
        assert.equal(health.recording.misses, 1);
      });
      assert.equal(existsSync(dir), true);
    });
  });
});
