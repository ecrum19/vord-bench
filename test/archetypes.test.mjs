import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  apportion, assignArchetypes, drawWeighted, endpointList, hashString, materialize, resolveProfiles, seededRandom,
} from '../proxy/lib/archetypes.mjs';
import { RateLimiter, TokenBucket } from '../proxy/lib/limiter.mjs';
import {
  loadProfiles, normalizeRestriction, restrictionsFor, serviceDescription, validateProfile, validateRestriction,
} from '../proxy/lib/profiles.mjs';
import { emptyAnswer, enforcementPlan, projectedVariables, validIdentification } from '../proxy/vord-proxy.mjs';

const PROFILES_DIR = new URL('../profiles', import.meta.url).pathname;

// A FedShop-like federation: blocks of 10 vendors and 10 rating sites.
function federation(blocks) {
  const endpoints = [];
  for (let block = 0; block < blocks; block++) {
    for (const group of [ 'vendor', 'ratingsite' ]) {
      for (let i = block * 10; i < (block + 1) * 10; i++) {
        endpoints.push({ name: `${group}${i}`, group });
      }
    }
  }
  return endpoints;
}

const count = (assignment, names) => {
  const counts = {};
  for (const name of names) {
    counts[assignment[name]] = (counts[assignment[name]] ?? 0) + 1;
  }
  return counts;
};

describe('seeded randomness', () => {
  it('is deterministic per seed', () => {
    assert.equal(hashString('abc'), hashString('abc'));
    assert.notEqual(hashString('abc'), hashString('abd'));
    const a = seededRandom(1, 'x');
    const b = seededRandom(1, 'x');
    const values = Array.from({ length: 5 }, () => a());
    assert.deepEqual(values, Array.from({ length: 5 }, () => b()));
    assert.ok(values.every(value => value >= 0 && value < 1));
    assert.notDeepEqual(values, Array.from({ length: 5 }, seededRandom(2, 'x')));
  });

  it('draws weighted values', () => {
    const draws = Array.from({ length: 2_000 }, (_, i) => drawWeighted([[ 'a', 9 ], [ 'b', 1 ]], seededRandom(i)));
    const share = draws.filter(value => value === 'a').length / draws.length;
    assert.ok(share > 0.85 && share < 0.95, `share ${share}`);
    assert.equal(drawWeighted([[ 'only', 1 ]], () => 0.999), 'only');
  });
});

describe('archetype assignment', () => {
  const profiles = loadProfiles(PROFILES_DIR);
  const shares = profiles.get('restrictive').mix.shares;

  it('gives every full block exactly the shares of the mix', () => {
    const endpoints = federation(2);
    const assignment = assignArchetypes({ blockSize: 20, shares }, endpoints, 1);
    for (const block of [ endpoints.slice(0, 20), endpoints.slice(20, 40) ]) {
      const counts = count(assignment, block.map(endpoint => endpoint.name));
      assert.deepEqual(counts, Object.fromEntries(Object.entries(shares).filter(([ , n ]) => n > 0)));
    }
  });

  it('splits archetypes that occur twice per block over the groups', () => {
    const endpoints = federation(2);
    const assignment = assignArchetypes({ blockSize: 20, shares }, endpoints, 3);
    for (const block of [ endpoints.slice(0, 20), endpoints.slice(20, 40) ]) {
      for (const [ id, n ] of Object.entries(shares).filter(([ , value ]) => value === 2)) {
        const groups = block.filter(endpoint => assignment[endpoint.name] === id).map(endpoint => endpoint.group);
        assert.deepEqual(groups.sort(), [ 'ratingsite', 'vendor' ], `${id} in both groups`);
        assert.equal(groups.length, n);
      }
      // Ten endpoints per group get an archetype.
      assert.equal(block.filter(endpoint => endpoint.group === 'vendor').length, 10);
    }
  });

  it('keeps the assignment of a member as the federation grows, and changes it with the seed', () => {
    const small = assignArchetypes({ blockSize: 20, shares }, federation(1), 1);
    const large = assignArchetypes({ blockSize: 20, shares }, federation(2), 1);
    for (const [ name, archetype ] of Object.entries(small)) {
      assert.equal(large[name], archetype);
    }
    assert.deepEqual(assignArchetypes({ blockSize: 20, shares }, federation(1), 1), small);
    assert.notDeepEqual(assignArchetypes({ blockSize: 20, shares }, federation(1), 2), small);
  });

  it('apportions small suites by largest remainder', () => {
    const counts = apportion(shares, 20, 5, seededRandom(1));
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 5);
    // Only archetypes with two endpoints per block can get one of five endpoints.
    for (const [ id, n ] of Object.entries(counts)) {
      assert.ok(n <= 1 && (n === 0 || shares[id] === 2), `${id}: ${n}`);
    }
    const watdiv = assignArchetypes({ blockSize: 20, shares }, endpointList({ all: {}, users: {}, products: {}, offers: {}, reviews: {}}), 1);
    assert.equal(Object.keys(watdiv).length, 5);
    assert.ok(Object.values(watdiv).every(id => shares[id] === 2));
  });

  it('draws values per endpoint', () => {
    const restriction = { id: 'results', type: 'ResultSizeRestriction', maxValue: 10_000, emulation: { maxValueDistribution: [[ 1_000, 1 ], [ 10_000, 1 ]]}};
    const values = new Set(Array.from({ length: 50 }, (_, i) => materialize([ restriction ], `e${i}`, 1)[0].maxValue));
    assert.deepEqual([ ...values ].sort((a, b) => a - b), [ 1_000, 10_000 ]);
    assert.equal(materialize([ restriction ], 'e1', 1)[0].maxValue, materialize([ restriction ], 'e1', 1)[0].maxValue);
    const plain = { id: 'rate', type: 'RateRestriction' };
    assert.equal(materialize([ plain ], 'e1', 1)[0], plain);
  });
});

describe('repository profiles', () => {
  const profiles = loadProfiles(PROFILES_DIR);

  it('loads the archetypes, the mixes with their seeds, and one profile per archetype', () => {
    for (const id of [ 'simple', 'simple-s2', 'simple-s3', 'restrictive', 'restrictive-s2', 'restrictive-s3' ]) {
      assert.ok(profiles.get(id)?.generic, id);
    }
    const archetypes = [ ...profiles.keys() ].filter(id => id.startsWith('archetype-'));
    assert.equal(archetypes.length, 14);
    assert.equal(profiles.get('restrictive-s2').mix.seed, 2);
    // The restrictive mix uses every archetype; the simple one only the documented policies.
    assert.equal(Object.keys(profiles.get('restrictive').mix.shares).length, 14);
    for (const archetype of Object.values(profiles.get('simple').archetypes)) {
      assert.equal(archetype.group, 'documented');
    }
  });

  it('resolves mixes and drawn values for the endpoints of a suite', () => {
    const endpoints = federation(2);
    const resolved = resolveProfiles(profiles, endpoints);
    const restrictive = resolved.get('restrictive');
    assert.equal(Object.keys(restrictive.assignment).length, 40);
    for (const { name } of endpoints) {
      const archetype = restrictive.archetypes[restrictive.assignment[name]];
      assert.deepEqual(restrictionsFor(restrictive, name).map(restriction => restriction.id),
        archetype.restrictions.map(restriction => restriction.id));
    }
    const caps = new Set(endpoints.map(({ name }) => restrictionsFor(resolved.get('archetype-virtuoso-default'), name)[0].maxValue));
    assert.ok(caps.has(10_000));
    assert.equal(resolved.get('P1-rate'), profiles.get('P1-rate'));
    assert.throws(() => restrictionsFor(profiles.get('restrictive'), 'vendor0'), /must first be resolved/u);
  });

  it('describes every archetype with VoRD terms', () => {
    const resolved = resolveProfiles(profiles, federation(1));
    const turtle = id => serviceDescription('http://localhost:4100/x/sparql', resolved.get(`archetype-${id}`), 'vendor0');
    assert.match(turtle('identified-email'), /vord:identificationHeader <http:\/\/www.w3.org\/2011\/http-headers#from> ;\n  vord:identificationFormat vord:EmailAddress/u);
    assert.match(turtle('usage-tokens'), /vord:metric vord:costUnitsPerWindow/u);
    assert.match(turtle('usage-tokens'), /vord:costModel <http:\/\/localhost:4100\/x\/sparql#units-v1> \./u);
    assert.match(turtle('usage-tokens'), /<http:\/\/localhost:4100\/x\/sparql#units-v1> a vord:CostModel ;\n  dcterms:description "A request costs 1 unit/u);
    assert.match(turtle('zero-tolerance'), /vord:penaltyThreshold "1"\^\^xsd:integer ;/u);
    assert.match(turtle('zero-tolerance'), /vord:penaltyDuration "PT10M"\^\^xsd:duration/u);
    assert.match(turtle('degrade-under-load'), /vord:metric vord:concurrentRequests/u);
    assert.match(turtle('shared-budget'), /vord:hasScope vord:GlobalScope/u);
    assert.doesNotMatch(turtle('shared-budget'), /background/u, 'emulation parameters are not advertised');
  });

  it('rejects malformed mixes and restrictions', () => {
    const archetypes = new Map([[ 'a', { id: 'a', restrictions: []}]]);
    assert.throws(() => validateProfile({ id: 'm', mix: { shares: { b: 20 }}}, 'm', archetypes), /unknown archetype b/u);
    assert.throws(() => validateProfile({ id: 'm', mix: { shares: { a: 19 }}}, 'm', archetypes), /add up to 19/u);
    assert.throws(() => validateProfile({ id: 'm', mix: { shares: { a: 1.5 }}}, 'm', archetypes), /count/u);
    assert.throws(() => validateProfile({ id: 'm', mix: { shares: {}}}, 'm', archetypes), /needs shares/u);
    assert.throws(() => validateProfile({ id: 'm', restrictions: [], mix: { shares: { a: 20 }}}, 'm', archetypes), /cannot also/u);
    const base = { id: 'r', hardRestriction: true };
    assert.throws(() => validateRestriction({ ...base, type: 'IdentificationRestriction', identificationHeader: 'from' }, 'x'), /identificationFormat/u);
    assert.throws(() => validateRestriction({ ...base, type: 'RateRestriction', windowDuration: 'PT1S', penaltyThreshold: 1 }, 'x'), /penaltyDuration/u);
    assert.throws(() => validateRestriction({ ...base, type: 'RateRestriction', windowDuration: 'PT1S', penaltyThreshold: 1, penaltyDuration: 'soon' }, 'x'), /invalid penaltyDuration/u);
    assert.throws(() => validateRestriction({ ...base, type: 'CostModelRestriction', metric: 'costUnitsPerWindow', maxValue: 5 }, 'x'), /usage budgets/u);
    assert.throws(() => validateRestriction({ ...base, type: 'RateRestriction', windowDuration: 'PT1S', emulation: { cost: {}}}, 'x'), /unknown emulation parameter cost/u);
  });
});

describe('emulation', () => {
  const rate = (extra = {}) => normalizeRestriction({ id: 'rate', type: 'RateRestriction', maxValue: 2, windowDuration: 'PT1S', ...extra });

  it('plans the new restrictions', () => {
    const plan = enforcementPlan([
      { id: 'id', type: 'IdentificationRestriction', identificationHeader: 'From', identificationFormat: 'EmailAddress' },
      { id: 'budget', type: 'CostModelRestriction', metric: 'costUnitsPerWindow', maxValue: 10, windowDuration: 'PT1M', costModel: 'm' },
      { id: 'anytime', type: 'ResponseTimeRestriction', maxValue: 60, enforcement: 'TruncateResult' },
      { id: 'results', type: 'ResultSizeRestriction', maxValue: 10, enforcement: 'TruncateResult', emulation: { silent: true }},
    ]);
    assert.equal(plan.identification[0].identificationHeader, 'from');
    assert.equal(plan.budget.maxValue, 10);
    assert.equal(plan.timeoutMs, 60_000);
    assert.equal(plan.timeoutDegrades, true);
    assert.equal(plan.resultSilent, true);
  });

  it('throttles requests over the limit of a tarpit by their excess', () => {
    const limiter = new RateLimiter(rate({ enforcement: 'ThrottleResponse', emulation: { delayPerExcessMs: 100 }}));
    assert.equal(limiter.mode, 'throttle');
    assert.deepEqual([ 0, 1, 2, 3 ].map(i => limiter.throttle(i)), [ 0, 0, 100, 200 ]);
    assert.equal(limiter.throttle(5_000), 0);
  });

  it('queues requests and counts the waiting ones', () => {
    const limiter = new RateLimiter(rate({ enforcement: 'QueueRequest', emulation: { queueLimit: 1 }}));
    assert.deepEqual(limiter.reserve(0), { time: 0, waiting: 0 });
    assert.deepEqual(limiter.reserve(0), { time: 0, waiting: 0 });
    assert.deepEqual(limiter.reserve(0), { time: 1_000, waiting: 1 });
    assert.deepEqual(limiter.reserve(0), { time: 1_000, waiting: 2 });
    limiter.cancelLast();
    assert.equal(limiter.windows.timestamps.length, 3);
  });

  it('shares a limit with background tenants', () => {
    const limiter = new RateLimiter(rate({ maxValue: 20, emulation: { background: { maxShare: 0.75, stepMs: 1_000 }}}), seededRandom(1));
    const shares = Array.from({ length: 20 }, (_, i) => limiter.backgroundShare(i * 1_000));
    assert.ok(shares.every(share => share >= 0 && share <= 0.75));
    assert.ok(new Set(shares).size > 1, 'the share varies');
    limiter.applyBackground(0);
    assert.equal(limiter.windows.windows[0].limit, Math.max(1, Math.round(20 * (1 - shares[0]))));
  });

  it('charges a usage budget for requests and their results', () => {
    const bucket = new TokenBucket(normalizeRestriction({
      id: 'budget', type: 'CostModelRestriction', metric: 'costUnitsPerWindow', maxValue: 60, burstValue: 5,
      windowDuration: 'PT60S', httpSignalHeader: 'X-Budget', emulation: { cost: { base: 1, aggregate: 1, rowsPerUnit: 100 }},
    }), 0);
    assert.equal(bucket.baseCost('SELECT ( COUNT( * ) AS ?c ) WHERE { ?s ?p ?o }'), 2);
    assert.equal(bucket.baseCost('SELECT ?s WHERE { ?s ?p ?o }'), 1);
    assert.equal(bucket.charge(2, 0), 0);
    assert.equal(bucket.chargeRows(250, 0), 2);
    assert.equal(bucket.charge(2, 0), 1_000, 'one unit is missing, restored after a second');
    assert.deepEqual(bucket.headers(2, 0), {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '1',
      'x-ratelimit-credits-used': '2',
      'x-ratelimit-reset': '4',
      'x-budget': '1',
    });
  });

  it('validates identification', () => {
    const email = { identificationFormat: 'EmailAddress' };
    const agent = { identificationFormat: 'ProductWithContact' };
    assert.ok(validIdentification(email, 'bench@example.org'));
    assert.ok(!validIdentification(email, 'bench'));
    assert.ok(!validIdentification(email, undefined));
    assert.ok(validIdentification(agent, 'Comunica/5.0 (https://example.org/bench; bench@example.org)'));
    assert.ok(validIdentification(agent, 'Bench/1.0 (bench@example.org)'));
    assert.ok(!validIdentification(agent, 'Comunica/5.0 actor-http-fetch/5.4.0 (Node.js v24; linux)'));
    assert.ok(!validIdentification(agent, 'bench@example.org'));
  });

  it('answers emptily with the projected variables', () => {
    assert.deepEqual(projectedVariables('SELECT ?a ?b WHERE { ?a ?p ?b }'), [ 'a', 'b' ]);
    assert.deepEqual(projectedVariables('SELECT ( COUNT( DISTINCT ?x ) AS ?count ) WHERE { ?x ?p ?o }'), [ 'count' ]);
    assert.deepEqual(projectedVariables('SELECT * { ?s ?p ?o }'), []);
    assert.deepEqual(projectedVariables('ASK { ?s ?p ?o }'), []);
    assert.deepEqual(JSON.parse(emptyAnswer('SELECT', 'SELECT ?o WHERE { ?s ?p ?o }').body), { head: { vars: [ 'o' ]}, results: { bindings: []}});
    assert.deepEqual(JSON.parse(emptyAnswer('ASK', 'ASK { ?s ?p ?o }').body), { head: {}, boolean: false });
    assert.deepEqual(emptyAnswer('CONSTRUCT', 'CONSTRUCT WHERE { ?s ?p ?o }'), { contentType: 'application/n-triples', body: '' });
  });
});
