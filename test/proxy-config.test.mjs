import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memberForUrl, normalizeConfig, normalizeEndpointUrl } from '../proxy/lib/config.mjs';
import { PolicyMonitor } from '../proxy/lib/policy.mjs';
import { Recorder } from '../proxy/lib/recorder.mjs';
import { SafetyLayer, matchesStatus } from '../proxy/lib/safety.mjs';
import { buildUpstreamRequest } from '../proxy/lib/upstream.mjs';
import { parseEndpointPath } from '../proxy/vord-proxy.mjs';

const UA = { 'user-agent': 'vord-bench-test/1.0' };

describe('proxy configuration', () => {
  it('reads the configuration of the existing benchmark unchanged', () => {
    const config = normalizeConfig({
      adminPort: 3099,
      endpoints: { all: { port: 3000, upstream: 'http://oxigraph-all:7878/query' }, users: { port: 3001, upstream: 'http://oxigraph-users:7878/query' }},
    });
    assert.equal(config.members.all.upstream.url, 'http://oxigraph-all:7878/query');
    assert.equal(config.members.all.upstream.method, 'POST');
    assert.equal(config.upstreams.size, 2);
    assert.equal(config.runHeader, 'x-vord-bench-run');
    assert.deepEqual(config.recording, { mode: 'off', dir: undefined, maxBytes: 64 * 1024 * 1024 });
  });

  it('shares upstreams between members', () => {
    const config = normalizeConfig({
      adminPort: 0,
      upstreams: { store: { url: 'http://virtuoso:8890/sparql', headers: { 'User-Agent': 'x' }}},
      endpoints: { v0: { port: 1, upstream: 'store', defaultGraph: 'http://v0' }, v1: { port: 2, upstream: 'store' }},
    });
    assert.equal(config.members.v0.upstream, config.members.v1.upstream);
    assert.equal(config.members.v0.defaultGraph, 'http://v0');
    assert.deepEqual(config.members.v0.upstream.headers, { 'user-agent': 'x' });
  });

  it('rejects inconsistent configurations', () => {
    const endpoints = { a: { port: 1, upstream: 'http://x/sparql' }};
    assert.throws(() => normalizeConfig({ adminPort: 0 }), /no endpoints/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, endpoints: { a: { port: 1, upstream: 'nope' }}}), /unknown upstream nope/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, endpoints: { 'a b': { port: 1, upstream: 'http://x' }}}), /URL-safe/u);
    assert.throws(() => normalizeConfig({ adminPort: 1, endpoints }), /share port 1/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, endpoints, requireSafety: true }), /requireSafety/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, upstreams: { u: { url: 'http://x', method: 'PUT' }}, endpoints }), /GET or POST/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, upstreams: { u: { url: 'http://x', safety: { budget: 5 }}}, endpoints }), /user-agent/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, upstreams: { u: { url: 'http://x', headers: UA, safety: { budget: -1 }}}, endpoints }), /positive/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, upstreams: { u: { url: 'http://x', headers: UA, safety: { rate: { maxValue: 1 }}}}, endpoints }), /windowDuration/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, upstreams: { u: { url: 'http://x', timeoutParameter: { name: 't', value: '5' }}}, endpoints }), /timeoutParameter/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, upstreams: { u: { url: 'http://x', policy: { restrictions: [{ id: 'r', type: 'Nope' }]}}}, endpoints }), /unknown type/u);
    assert.throws(() => normalizeConfig({ adminPort: 0, endpoints, recording: { mode: 'record' }}), /dir/u);
    assert.throws(() => normalizeConfig({
      adminPort: 0,
      upstreams: { u1: { url: 'http://x/a', headers: UA, safety: { budget: 1 }}, u2: { url: 'http://x/b' }},
      endpoints,
    }), /different safety limits/u);
  });

  it('finds the member of an endpoint URL, including aliases and trailing slashes', () => {
    const config = normalizeConfig({
      adminPort: 0,
      endpoints: {
        uniprot: { port: 1, upstream: 'https://sparql.uniprot.org/sparql', aliases: [ 'http://sparql.uniprot.org/sparql' ]},
        rhea: { port: 2, upstream: 'https://sparql.rhea-db.org/sparql' },
      },
    });
    assert.equal(memberForUrl(config, 'https://sparql.uniprot.org/sparql/').name, 'uniprot');
    assert.equal(memberForUrl(config, 'HTTP://SPARQL.UNIPROT.ORG/sparql').name, 'uniprot');
    assert.equal(memberForUrl(config, 'https://sparql.rhea-db.org/sparql').name, 'rhea');
    assert.equal(memberForUrl(config, 'https://example.org/sparql'), undefined);
    assert.equal(normalizeEndpointUrl('https://example.org:443/'), 'https://example.org/');
  });

  it('parses endpoint paths with description modes', () => {
    assert.deepEqual(parseEndpointPath('/P1-rate/sparql'), { profileId: 'P1-rate', mode: 'advertised' });
    assert.deepEqual(parseEndpointPath('/P1-rate/provided/sparql'), { profileId: 'P1-rate', mode: 'provided' });
    assert.deepEqual(parseEndpointPath('/P1-rate/none/sparql'), { profileId: 'P1-rate', mode: 'none' });
    assert.equal(parseEndpointPath('/P1-rate/other/sparql'), undefined);
    assert.equal(parseEndpointPath('/sparql'), undefined);
  });
});

describe('upstream requests', () => {
  const upstream = normalizeConfig({
    adminPort: 0,
    upstreams: { u: { url: 'https://example.org/sparql?key=1', method: 'GET', headers: { Accept: 'text/html', 'User-Agent': 'ua' }, timeoutParameter: { name: 'timeout', value: '{ms}' }}},
    endpoints: { a: { port: 1, upstream: 'u' }},
  }).members.a.upstream;

  it('builds GET requests with parameters, configured headers and the media type for the query form', () => {
    const { url, init } = buildUpstreamRequest(upstream, { query: 'SELECT * {}', form: 'SELECT', defaultGraph: 'http://g', timeoutMs: 2_000 });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('key'), '1');
    assert.equal(parsed.searchParams.get('query'), 'SELECT * {}');
    assert.equal(parsed.searchParams.get('default-graph-uri'), 'http://g');
    assert.equal(parsed.searchParams.get('timeout'), '2000');
    assert.deepEqual(init, { method: 'GET', headers: { 'user-agent': 'ua', accept: 'application/sparql-results+json' }});
    assert.equal(buildUpstreamRequest(upstream, { query: 'CONSTRUCT {} {}', form: 'CONSTRUCT' }).init.headers.accept, 'application/n-triples');
  });

  it('builds POST requests by default', () => {
    const post = normalizeConfig({ adminPort: 0, endpoints: { a: { port: 1, upstream: 'http://x/sparql' }}}).members.a.upstream;
    const { url, init } = buildUpstreamRequest(post, { query: 'ASK {}', form: 'ASK', timeoutMs: 1_000 });
    assert.equal(url, 'http://x/sparql');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(init.body, 'query=ASK+%7B%7D');
  });
});

describe('safety layer', () => {
  const upstreams = safety => normalizeConfig({
    adminPort: 0,
    upstreams: { u: { url: 'https://example.org/sparql', headers: UA, safety }},
    endpoints: { a: { port: 1, upstream: 'u' }},
  }).members.a.upstream;

  it('matches statuses and status classes', () => {
    assert.equal(matchesStatus([ 403, '5xx' ], 403), true);
    assert.equal(matchesStatus([ 403, '5xx' ], 502), true);
    assert.equal(matchesStatus([ 403, '5xx' ], 429), false);
    assert.equal(matchesStatus([], 'error'), true);
  });

  it('counts the budget and refuses beyond it', async() => {
    const upstream = upstreams({ budget: 1 });
    const layer = new SafetyLayer([ upstream ], { clock: () => 0 });
    const first = await layer.admit(upstream);
    assert.equal(first.ok, true);
    first.release();
    assert.deepEqual(await layer.admit(upstream), { ok: false, reason: 'budget', waitMs: 0 });
    assert.deepEqual(layer.status().hosts['example.org'].refused, { budget: 1 });
  });

  it('opens the breaker within its window only', () => {
    let now = 0;
    const upstream = upstreams({ breaker: { threshold: 2, windowDuration: 'PT10S' }});
    const layer = new SafetyLayer([ upstream ], { clock: () => now });
    layer.report(upstream, 429);
    now = 20_000;
    layer.report(upstream, 429);
    assert.equal(layer.tripped, false, 'the first error is outside the window');
    layer.report(upstream, 200);
    layer.report(upstream, 'error');
    assert.equal(layer.tripped, true);
    assert.equal(layer.close('other.org'), 0);
    assert.equal(layer.close('example.org'), 1);
    assert.equal(layer.tripped, false);
  });

  it('limits concurrency and lets waiting stop', async() => {
    const upstream = upstreams({ concurrency: 1 });
    const layer = new SafetyLayer([ upstream ]);
    const first = await layer.admit(upstream);
    const controller = new AbortController();
    const second = layer.admit(upstream, controller.signal);
    controller.abort(new Error('gone'));
    await assert.rejects(second, /gone/u);
    first.release();
    const third = await layer.admit(upstream);
    assert.equal(third.ok, true);
    third.release();
  });
});

describe('policy monitor', () => {
  const upstream = restrictions => normalizeConfig({
    adminPort: 0,
    upstreams: { u: { url: 'https://example.org/sparql', policy: { restrictions }}},
    endpoints: { a: { port: 1, upstream: 'u' }},
  }).members.a.upstream;

  it('checks rate, concurrency and response time', () => {
    let now = 0;
    const monitor = new PolicyMonitor({ clock: () => now });
    const policy = upstream([
      { id: 'rate', type: 'RateRestriction', maxValue: 2, windowDuration: 'PT1S' },
      { id: 'concurrency', type: 'ConcurrentRequestsRestriction', maxValue: 2 },
      { id: 'time', type: 'ResponseTimeRestriction', maxValue: 1 },
      { id: 'soft', type: 'RateRestriction', maxValue: 1, windowDuration: 'PT1S', hardRestriction: false },
    ]);
    const first = monitor.arrive(policy);
    const second = monitor.arrive(policy);
    const third = monitor.arrive(policy);
    assert.deepEqual([ first.violations, second.violations, third.violations ], [[], [], [ 'rate', 'concurrency' ]]);
    assert.deepEqual(first.done(500), []);
    assert.deepEqual(second.done(1_500), [ 'responseTime' ]);
    assert.deepEqual(second.done(1_500), [], 'a request ends once');
    third.done();
    now = 1_001;
    assert.deepEqual(monitor.arrive(policy).violations, []);
  });

  it('checks nothing without a policy', () => {
    const plain = normalizeConfig({ adminPort: 0, endpoints: { a: { port: 1, upstream: 'http://x' }}}).members.a.upstream;
    assert.deepEqual(new PolicyMonitor().arrive(plain).violations, []);
  });
});

describe('recorder', () => {
  it('keys requests by member, media type and query, ignoring surrounding whitespace and line endings', () => {
    const key = Recorder.key('a', 'SELECT *\r\n{}', 'application/json');
    assert.equal(key, Recorder.key('a', '  SELECT *\n{}\n', 'application/json'));
    assert.notEqual(key, Recorder.key('b', 'SELECT *\n{}', 'application/json'));
    assert.notEqual(key, Recorder.key('a', 'SELECT *\n{}', 'text/csv'));
    assert.notEqual(key, Recorder.key('a', 'SELECT  *\n{}', 'application/json'));
  });

  it('does nothing when off', async() => {
    const recorder = new Recorder();
    assert.equal(await recorder.lookup('a', 'q', 'x'), undefined);
    assert.equal(await recorder.store('a', 'q', 'x', { status: 200, contentType: 'x', body: Buffer.from('b'), upstreamMs: 1 }), false);
  });
});
