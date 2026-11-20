import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { durationToMs } from '../proxy/lib/duration.mjs';
import { ConcurrencyGate, SlidingWindows } from '../proxy/lib/limiter.mjs';
import { loadProfiles, normalizeRestriction, restrictionsFor, serviceDescription, validateProfile } from '../proxy/lib/profiles.mjs';
import { getQueryForm, truncateResults, upstreamAccept } from '../proxy/lib/sparql.mjs';
import { enforcementPlan } from '../proxy/vord-proxy.mjs';

describe('durationToMs', () => {
  it('converts xsd:duration values', () => {
    assert.equal(durationToMs('PT1M'), 60_000);
    assert.equal(durationToMs('PT6S'), 6_000);
    assert.equal(durationToMs('PT0.2S'), 200);
    assert.equal(durationToMs('P1D'), 86_400_000);
    assert.equal(durationToMs('P1DT1H'), 90_000_000);
    assert.equal(durationToMs('P1Y'), 365 * 86_400_000);
    assert.equal(durationToMs('P1M'), 30 * 86_400_000);
  });

  it('rejects invalid and non-positive durations', () => {
    for (const value of [ 'P', 'PT', 'PT0S', '1M', 'PT-1S', 'abc', undefined ]) {
      assert.equal(durationToMs(value), undefined, String(value));
    }
  });

  it('passes milliseconds through', () => {
    assert.equal(durationToMs(500), 500);
    assert.equal(durationToMs(0), undefined);
  });
});

describe('SlidingWindows', () => {
  it('allows limit requests per window', () => {
    const windows = new SlidingWindows([{ limit: 2, durationMs: 1_000 }]);
    assert.equal(windows.waitTime(0), 0);
    windows.record(0);
    windows.record(100);
    assert.equal(windows.waitTime(200), 800);
    assert.equal(windows.waitTime(999), 1);
    assert.equal(windows.waitTime(1_000), 0);
    windows.record(1_000);
    assert.equal(windows.waitTime(1_000), 100);
  });

  it('applies the most restrictive of several windows', () => {
    const windows = new SlidingWindows([{ limit: 10, durationMs: 1_000 }, { limit: 2, durationMs: 200 }]);
    windows.record(0);
    windows.record(10);
    assert.equal(windows.waitTime(20), 180);
    assert.equal(windows.waitTime(200), 0);
  });

  it('builds windows from rate restrictions with bursts', () => {
    const windows = SlidingWindows.fromRestrictions([
      normalizeRestriction({ id: 'r', type: 'RateRestriction', maxValue: 60, burstValue: 15, windowDuration: 'PT6S' }),
    ]);
    assert.deepEqual(windows.windows, [{ limit: 60, durationMs: 6_000 }, { limit: 15, durationMs: 1_500 }]);
  });

  it('ignores restrictions without a usable window', () => {
    assert.equal(SlidingWindows.fromRestrictions([
      normalizeRestriction({ id: 'r', type: 'RateRestriction', maxValue: 0, windowDuration: 'PT6S' }),
      normalizeRestriction({ id: 's', type: 'RateRestriction', maxValue: 5 }),
    ]), undefined);
  });

  it('treats requestsPerDay without a window as a daily window', () => {
    const restriction = normalizeRestriction({ id: 'q', type: 'QuotaRestriction', metric: 'requestsPerDay', maxValue: 5 });
    assert.equal(restriction.windowMs, 86_400_000);
  });
});

describe('ConcurrencyGate', () => {
  it('limits the number of active slots and hands slots over in order', async() => {
    const gate = new ConcurrencyGate(1);
    assert.equal(gate.tryAcquire(), true);
    assert.equal(gate.tryAcquire(), false);
    const order = [];
    const first = gate.acquire().then(() => order.push('first'));
    const second = gate.acquire().then(() => order.push('second'));
    gate.release();
    await first;
    assert.equal(gate.active, 1);
    gate.release();
    await second;
    assert.deepEqual(order, [ 'first', 'second' ]);
    gate.release();
    assert.equal(gate.active, 0);
  });
});

describe('SPARQL helpers', () => {
  it('detects query forms after prologues and comments', () => {
    assert.equal(getQueryForm('SELECT * WHERE {}'), 'SELECT');
    assert.equal(getQueryForm('PREFIX ex: <http://ex.org/>\n# comment\nconstruct { ?s ?p ?o } WHERE {}'), 'CONSTRUCT');
    assert.equal(getQueryForm('BASE <http://ex.org/> ASK {}'), 'ASK');
    assert.equal(getQueryForm('INSERT DATA {}'), undefined);
    assert.equal(upstreamAccept('SELECT'), 'application/sparql-results+json');
    assert.equal(upstreamAccept('DESCRIBE'), 'application/n-triples');
  });

  it('truncates SPARQL JSON results', () => {
    const body = JSON.stringify({ head: { vars: [ 'x' ]}, results: { bindings: [ 1, 2, 3 ].map(i => ({ x: { type: 'literal', value: `${i}` }})) }});
    const truncated = truncateResults(body, 'application/sparql-results+json', 2);
    assert.equal(truncated.rows, 2);
    assert.equal(truncated.truncated, true);
    assert.equal(JSON.parse(truncated.body).results.bindings.length, 2);
    assert.deepEqual(truncateResults(body, 'application/sparql-results+json', 3), { body, rows: 3, truncated: false });
    assert.deepEqual(truncateResults(body, 'application/sparql-results+json', undefined), { body, rows: 3, truncated: false });
  });

  it('passes ASK results and unknown formats through', () => {
    const ask = JSON.stringify({ head: {}, boolean: true });
    assert.deepEqual(truncateResults(ask, 'application/sparql-results+json', 1), { body: ask, rows: undefined, truncated: false });
    assert.deepEqual(truncateResults('x', 'text/plain', 1), { body: 'x', rows: undefined, truncated: false });
  });

  it('truncates N-Triples', () => {
    const body = '<a> <b> <c> .\n<a> <b> <d> .\n<a> <b> <e> .\n';
    assert.deepEqual(truncateResults(body, 'application/n-triples', 2), { body: '<a> <b> <c> .\n<a> <b> <d> .\n', rows: 2, truncated: true });
    assert.equal(truncateResults(body, 'application/n-triples', 5).rows, 3);
  });
});

describe('profiles', () => {
  const profiles = loadProfiles(new URL('../profiles', import.meta.url).pathname);

  it('loads all profiles in the repository', () => {
    assert.deepEqual([ ...profiles.keys() ].filter(id => !id.startsWith('archetype-')), [
      'P0-none', 'P1-rate', 'P2-burst', 'P3-truncate', 'P4-concurrency', 'P5-timeout', 'P6-combined', 'P7-mixed', 'P8-unadvertised',
      'restrictive', 'restrictive-s2', 'restrictive-s3', 'simple', 'simple-s2', 'simple-s3',
    ]);
  });

  it('rejects malformed profiles', () => {
    assert.throws(() => validateProfile({ id: 'a b' }), /URL-safe/u);
    assert.throws(() => validateProfile({ id: 'p', restrictions: [{ id: 'r', type: 'Nope' }]}), /unknown type/u);
    assert.throws(() => validateProfile({ id: 'p', restrictions: [{ id: 'r', type: 'RateRestriction', maxValue: 1 }]}), /windowDuration/u);
    assert.throws(() => validateProfile({ id: 'p', restrictions: [{ id: 'r', type: 'RateRestriction', windowDuration: 'PTX' }]}), /invalid windowDuration/u);
    assert.throws(() => validateProfile({ id: 'p', restrictions: [{ id: 'r', type: 'ResultSizeRestriction', enforcement: 'Nope' }]}), /enforcement/u);
  });

  it('selects restrictions per endpoint', () => {
    const mixed = profiles.get('P7-mixed');
    assert.equal(restrictionsFor(mixed, 'users')[0].type, 'RateRestriction');
    assert.deepEqual(restrictionsFor(mixed, 'reviews'), []);
    assert.deepEqual(restrictionsFor(mixed, 'all'), []);
    assert.equal(restrictionsFor(profiles.get('P1-rate'), 'anything').length, 1);
  });

  it('describes restrictions in the service description', () => {
    const turtle = serviceDescription('http://localhost:3001/P1-rate/sparql', profiles.get('P1-rate'), 'users');
    assert.match(turtle, /<http:\/\/localhost:3001\/P1-rate\/sparql#service> a sd:Service ;/u);
    assert.match(turtle, /sd:endpoint <http:\/\/localhost:3001\/P1-rate\/sparql> ;/u);
    assert.match(turtle, /vord:hasRestriction <http:\/\/localhost:3001\/P1-rate\/sparql#rate> \./u);
    assert.match(turtle, /a vord:Restriction, vord:RateRestriction ;/u);
    assert.match(turtle, /vord:maxValue "10"\^\^xsd:integer ;/u);
    assert.match(turtle, /vord:windowDuration "PT6S"\^\^xsd:duration ;/u);
    assert.match(turtle, /vord:hasScope vord:PerClientIP ;/u);
    assert.match(turtle, /vord:httpSignalHeader <http:\/\/www.w3.org\/2011\/http-headers#retry-after> \./u);
  });

  it('describes no restrictions for unrestricted and unadvertised profiles', () => {
    for (const id of [ 'P0-none', 'P8-unadvertised' ]) {
      const turtle = serviceDescription('http://localhost:3000/x/sparql', profiles.get(id), 'all');
      assert.doesNotMatch(turtle, /vord:hasRestriction/u);
      assert.match(turtle, /sd:resultFormat .* \.\n$/u);
    }
  });

  it('plans the enforcement of hard restrictions only', () => {
    const plan = enforcementPlan(restrictionsFor(profiles.get('P6-combined'), 'all'));
    assert.equal(plan.rates.length, 1, 'the soft daily quota is not enforced');
    assert.equal(plan.rates[0].enforcement, 'RejectRequest');
    assert.equal(plan.rates[0].statusCode, 429);
    assert.equal(plan.concurrency.maxValue, 3);
    assert.equal(plan.timeoutMs, 2_000);
    assert.equal(plan.resultLimit, 1_000);
    assert.equal(plan.resultReject, false);
    assert.deepEqual(enforcementPlan([]), {
      rates: [], concurrency: undefined, timeoutMs: undefined, timeoutStatus: 503, timeoutDegrades: false,
      timeoutRestriction: undefined, resultLimit: undefined, resultReject: false, resultStatus: 413, resultSilent: false,
      budget: undefined, identification: [],
    });
  });
});
