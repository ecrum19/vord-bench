import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPartitioner, split } from '../data/split.mjs';
import { aggregate, formatRows, groupBy } from '../harness/analyze.mjs';
import { buildEngineConfig } from '../harness/generate-engines.mjs';
import { ResultMatcher, bindingsKey, jsonRowKey, jsonTermKey, termKey } from '../harness/lib/canonical.mjs';
import { compareTemplates, loadQueries, splitQueries } from '../harness/lib/queries.mjs';
import { createRecordingFetch, summarizeRequests } from '../harness/run-query.mjs';
import { buildPlan, sourcesFor } from '../harness/run.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const namedNode = value => ({ termType: 'NamedNode', value });
const literal = (value, language = '', datatype = `${XSD}string`) =>
  ({ termType: 'Literal', value, language, datatype: namedNode(datatype) });

describe('canonical results', () => {
  it('gives RDF/JS terms and SPARQL JSON terms the same keys', () => {
    const pairs = [
      [ namedNode('http://ex.org/a'), { type: 'uri', value: 'http://ex.org/a' }],
      [ literal('a "b"'), { type: 'literal', value: 'a "b"' }],
      [ literal('a', 'EN', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'), { type: 'literal', value: 'a', 'xml:lang': 'en' }],
      [ literal('1', '', `${XSD}integer`), { type: 'literal', value: '1', datatype: `${XSD}integer` }],
      [ literal('1', '', `${XSD}integer`), { type: 'typed-literal', value: '1', datatype: `${XSD}integer` }],
      [ literal('x', '', `${XSD}string`), { type: 'literal', value: 'x', datatype: `${XSD}string` }],
      [{ termType: 'BlankNode', value: 'b0' }, { type: 'bnode', value: 'b0' }],
    ];
    for (const [ term, json ] of pairs) {
      assert.equal(termKey(term), jsonTermKey(json));
    }
    assert.throws(() => jsonTermKey({ type: 'triple', value: '' }), /Unknown/u);
  });

  it('gives Comunica bindings and SPARQL JSON rows the same keys, independent of variable order', () => {
    const bindings = new Map([
      [ { value: 'y' }, literal('1', '', `${XSD}integer`) ],
      [ { value: 'x' }, namedNode('http://ex.org/a') ],
    ]);
    const row = { x: { type: 'uri', value: 'http://ex.org/a' }, y: { type: 'literal', value: '1', datatype: `${XSD}integer` }};
    assert.equal(bindingsKey(bindings), jsonRowKey(row));
    assert.equal(jsonRowKey(row), `?x=<http://ex.org/a> ?y="1"^^<${XSD}integer>`);
  });

  it('ignores blank node labels', () => {
    assert.equal(bindingsKey(new Map([[ { value: 'x' }, { termType: 'BlankNode', value: 'a1' }]])),
      jsonRowKey({ x: { type: 'bnode', value: 'other' }}));
  });

  it('matches results as multisets', () => {
    const matcher = new ResultMatcher([ 'a', 'a', 'b' ]);
    for (const key of [ 'a', 'c', 'a', 'a' ]) {
      matcher.add(key);
    }
    assert.deepEqual(matcher.summary(), { expected: 3, results: 4, matched: 2, extra: 2, recall: 2 / 3, precision: 0.5 });
    assert.deepEqual(new ResultMatcher([]).summary(), { expected: 0, results: 0, matched: 0, extra: 0, recall: 1, precision: 1 });
  });
});

describe('queries', () => {
  it('splits WatDiv query files into instances', () => {
    assert.deepEqual(splitQueries('SELECT * WHERE {\n\t?s ?p ?o .\n}\n\nSELECT ?s WHERE {\n}\n\n'), [
      'SELECT * WHERE {\n\t?s ?p ?o .\n}',
      'SELECT ?s WHERE {\n}',
    ]);
  });

  it('loads selected templates and instances in WatDiv order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queries-'));
    writeFileSync(join(dir, 'S2.txt'), 'SELECT 2 {}\n\nSELECT 3 {}\n');
    writeFileSync(join(dir, 'L1.txt'), 'SELECT 1 {}\n');
    writeFileSync(join(dir, 'C1.txt'), 'SELECT 4 {}\n');
    assert.deepEqual(loadQueries(dir).map(query => query.id), [ 'L1-0', 'S2-0', 'C1-0' ]);
    assert.deepEqual(loadQueries(dir, { templates: [ 'S2' ], instances: 5 }).map(query => query.query), [ 'SELECT 2 {}', 'SELECT 3 {}' ]);
    assert.deepEqual(loadQueries(dir, { templates: [ 'S2' ], counts: { 'S2-0': 0, 'S2-1': 3 }}).map(query => query.id), [ 'S2-1' ]);
    assert.deepEqual(loadQueries(dir, { templates: [ 'S2' ], counts: {}}).map(query => query.id), [ 'S2-0' ]);
    assert.throws(() => loadQueries(dir, { templates: [ 'F9' ]}), /Unknown query template F9/u);
    assert.throws(() => loadQueries(join(dir, 'missing')), /does not exist/u);
    assert.deepEqual([ 'C1', 'S10', 'L2', 'F1', 'S2' ].sort(compareTemplates), [ 'L2', 'S2', 'S10', 'F1', 'C1' ]);
  });
});

describe('split', () => {
  const spec = { default: 'rest', partitions: { users: [ 'User' ], rest: [ 'Product' ]}};

  it('assigns triples by the type of their subject', () => {
    const partitionOf = createPartitioner(spec);
    assert.equal(partitionOf('<http://db.uwaterloo.ca/~galuc/wsdbm/User12>\t<http://ex.org/p>\t"x" .'), 'users');
    assert.equal(partitionOf('<http://db.uwaterloo.ca/~galuc/wsdbm/Product3> <http://ex.org/p> "x" .'), 'rest');
    assert.equal(partitionOf('<http://ex.org/Other> <http://ex.org/p> "x" .'), 'rest');
    assert.equal(partitionOf('_:b0 <http://ex.org/p> "x" .'), 'rest');
  });

  it('writes every triple to exactly one partition', async() => {
    const dir = mkdtempSync(join(tmpdir(), 'split-'));
    const lines = [
      '<http://ex.org/User1> <http://ex.org/p> "a" .',
      '<http://ex.org/Product1> <http://ex.org/p> "b" .',
      '',
      '<http://ex.org/User2> <http://ex.org/p> "c" .',
    ];
    writeFileSync(join(dir, 'in.nt'), `${lines.join('\n')}\n`);
    assert.deepEqual(await split(join(dir, 'in.nt'), join(dir, 'out'), spec), { users: 2, rest: 1 });
    assert.equal(readFileSync(join(dir, 'out', 'users.nt'), 'utf8'), `${lines[0]}\n${lines[3]}\n`);
  });
});

describe('engine generation', () => {
  const base = { import: [ 'ccqs:a.json', 'ccqs:http.json', 'ccqs:c.json' ]};

  it('replaces imports in place and adds overrides', () => {
    const config = buildEngineConfig(base, {
      replaceImports: { 'ccqs:http.json': [ 'ccqs:h1.json', 'ccqs:h2.json' ]},
      contexts: [ 'ctx' ],
      overrides: [{ '@id': 'o' }],
    });
    assert.deepEqual(config.import, [ 'ccqs:a.json', 'ccqs:h1.json', 'ccqs:h2.json', 'ccqs:c.json' ]);
    assert.equal(config['@context'].at(-1), 'ctx');
    assert.deepEqual(config['@graph'], [{ '@id': 'o' }]);
    assert.deepEqual(base.import, [ 'ccqs:a.json', 'ccqs:http.json', 'ccqs:c.json' ], 'the base is not modified');
    assert.equal(buildEngineConfig(base, {})['@graph'], undefined);
  });

  it('fails for imports that the base config does not have', () => {
    assert.throws(() => buildEngineConfig(base, { replaceImports: { 'ccqs:x.json': []}}), /does not import ccqs:x.json/u);
  });

  it('only replaces imports that exist in the fork, for every configured engine', () => {
    const engines = JSON.parse(readFileSync(new URL('../engines/engines.json', import.meta.url), 'utf8')).engines;
    assert.deepEqual(Object.keys(engines), [ 'A-naive', 'B-backoff', 'Bp-backoff-eager', 'C-vord-http', 'D-vord-full' ]);
    const originals = new Set(Object.values(engines).flatMap(engine => Object.keys(engine.replaceImports ?? {})));
    assert.deepEqual([ ...originals ].sort(), [
      'ccqs:config/http/actors-v5-4-1.json',
      'ccqs:config/rdf-metadata-extract/actors-v5-4-1.json',
    ]);
  });
});

describe('run plan', () => {
  const queries = [ 'L1-0', 'S1-0' ].map(id => ({ id }));

  it('interleaves engines per query and rotates them per replication', () => {
    const plan = buildPlan({
      profiles: [{ id: 'P1' }, { id: 'P7', scenarios: [ 'federated' ]}],
      scenarios: [ 'single', 'federated' ],
      engines: [ 'A', 'B', 'C' ],
      queries,
      replications: 2,
    });
    assert.equal(plan.length, (2 + 1) * 2 * 2 * 3);
    assert.deepEqual(plan.slice(0, 6).map(run => `${run.query.id}:${run.rep}:${run.engine}`), [
      'L1-0:0:A', 'L1-0:0:B', 'L1-0:0:C', 'L1-0:1:B', 'L1-0:1:C', 'L1-0:1:A',
    ]);
    assert.equal(plan.filter(run => run.profile === 'P7' && run.scenario === 'single').length, 0);
    assert.equal(new Set(plan.map(run => run.runId)).size, plan.length);
  });

  it('builds source URLs per endpoint and profile', () => {
    const config = {
      proxy: { baseUrl: 'http://localhost' },
      scenarios: { federated: [ 'users', 'reviews' ]},
      endpoints: { users: { port: 3001 }, reviews: { port: 3004 }},
    };
    assert.deepEqual(sourcesFor(config, 'federated', 'P1-rate'), [
      'http://localhost:3001/P1-rate/sparql',
      'http://localhost:3004/P1-rate/sparql',
    ]);
  });
});

describe('request recording', () => {
  it('summarizes requests by kind, status and host', () => {
    assert.deepEqual(summarizeRequests([
      { host: 'a:1', kind: 'sd', status: 200 },
      { host: 'a:1', kind: 'query', status: 429 },
      { host: 'b:2', kind: 'query', status: 200 },
      { host: 'b:2', kind: 'query' },
    ]), {
      total: 4, queries: 3, serviceDescriptions: 1, byStatus: { 200: 2, 429: 1, pending: 1 }, byHost: { 'a:1': 2, 'b:2': 2 },
    });
  });

  it('records requests made through the wrapped fetch', async() => {
    const { recordingFetch, requests } = createRecordingFetch(() => 0);
    await assert.rejects(recordingFetch('http://127.0.0.1:9/sparql?query=x'));
    assert.deepEqual(requests.map(({ host, kind, status }) => ({ host, kind, status })), [{ host: '127.0.0.1:9', kind: 'query', status: 'failed' }]);
  });
});

describe('analysis', () => {
  it('aggregates runs', () => {
    const runs = [
      { profile: 'P', scenario: 's', engine: 'A', status: 'ok', recall: 1, precision: 1, timeMs: 1_000, ttfrMs: 100, requests: { total: 4, byStatus: { 200: 4 }}, server: { truncated: 0 }},
      { profile: 'P', scenario: 's', engine: 'A', status: 'ok', recall: 0.5, precision: 1, timeMs: 3_000, ttfrMs: 300, requests: { total: 6, byStatus: { 200: 4, 429: 2 }}, server: { truncated: 1 }},
      { profile: 'P', scenario: 's', engine: 'B', status: 'error', recall: 0, timeMs: 500, requests: { total: 1, byStatus: { 503: 1 }}},
    ];
    const groups = groupBy(runs, [ 'profile', 'engine' ]);
    assert.deepEqual(groups.map(group => group.keys), [{ profile: 'P', engine: 'A' }, { profile: 'P', engine: 'B' }]);
    assert.deepEqual(aggregate(groups[0].runs), {
      runs: 2, failed: 0, complete: 1, recall: 0.75, timeS: 2, ttfrS: 0.2, requests: 5, rejected429: 1, rejected503: 0, truncated: 0.5,
    });
    assert.equal(formatRows([{ engine: 'A', recall: 0.75, runs: 2, timeS: undefined }], 'csv'), 'engine,recall,runs,timeS\nA,0.75,2,\n');
    assert.equal(formatRows([{ engine: 'A', recall: 1 }], 'md'), '| engine | recall |\n|---|---|\n| A | 1 |\n');
    assert.deepEqual(aggregate(groups[1].runs), {
      runs: 1, failed: 1, complete: 0, recall: 0, timeS: undefined, ttfrS: undefined, requests: 1, rejected429: 0, rejected503: 1, truncated: 0,
    });
  });
});
