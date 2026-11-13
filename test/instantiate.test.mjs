import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  candidateQuery,
  findConstants,
  findPlaceholders,
  instantiateTemplate,
  pickCandidates,
  replaceConstants,
} from '../harness/lib/instantiate.mjs';

const W = 'http://db.uwaterloo.ca/~galuc/wsdbm/';
const iri = name => `<${W}${name}>`;
const s2 = (country, role = 'Role2') =>
  `SELECT ?v0 WHERE {\n\t?v0 <ex:nationality> ${iri(country)} .\n\t?v0 <ex:type> ${iri(role)} .\n}`;

describe('query instantiation', () => {
  it('finds the entity constants of a query once', () => {
    assert.deepEqual(findConstants(`${s2('Country1')} ${iri('Country1')}`), [ iri('Country1'), iri('Role2') ]);
    assert.deepEqual(findConstants('SELECT * WHERE { ?s <ex:p> <ex:o> }'), []);
  });

  it('finds the constants that differ between instances', () => {
    assert.deepEqual(findPlaceholders([ s2('Country13'), s2('Country16'), s2('Country13') ]), [ iri('Country13') ]);
    assert.deepEqual(findPlaceholders([ s2('Country1'), s2('Country1') ]), []);
  });

  it('replaces constants', () => {
    assert.equal(replaceConstants(s2('Country1'), [ iri('Country1') ], [ '?c' ]), s2('Country1').replace(iri('Country1'), '?c'));
  });

  it('counts the results per value of the constants', () => {
    assert.equal(
      candidateQuery(s2('Country1'), [ iri('Country1') ]),
      `SELECT ?__c0 (COUNT(*) AS ?__n) WHERE {\n\t?v0 <ex:nationality> ?__c0 .\n\t?v0 <ex:type> ${iri('Role2')} .\n}\n` +
      'GROUP BY ?__c0',
    );
  });

  it('picks candidates at the quantiles of their result counts, median first', () => {
    const candidates = [ 5, 1, 3, 2, 4 ].map(count => ({ values: [ `v${count}` ], count }));
    assert.deepEqual(pickCandidates(candidates, 5).map(candidate => candidate.count), [ 3, 2, 4, 1, 5 ]);
    assert.deepEqual(pickCandidates(candidates, 1).map(candidate => candidate.count), [ 3 ]);
    assert.deepEqual(pickCandidates(candidates.slice(0, 1), 5).map(candidate => candidate.count), [ 5 ]);
    assert.deepEqual(pickCandidates([], 5), []);
  });

  it('instantiates templates with values that have results', async() => {
    const queries = [];
    const result = await instantiateTemplate(
      [ s2('Country13'), s2('Country16') ],
      async(query) => {
        queries.push(query);
        return [{ values: [ `${W}Country3` ], count: 7 }];
      },
      async() => assert.fail('no counts for templates with placeholders'),
      5,
    );
    assert.deepEqual(result.queries, [ s2('Country3') ]);
    assert.deepEqual(result.placeholders, [ iri('Country13') ]);
    assert.equal(result.relaxed, false);
    assert.equal(queries.length, 1);
  });

  it('relaxes the constants of a template if no placeholder values have results', async() => {
    const result = await instantiateTemplate(
      [ s2('Country13'), s2('Country16') ],
      async query => query.includes('?__c1') ? [{ values: [ `${W}Country3`, `${W}Role1` ], count: 2 }] : [],
      async() => 0,
      5,
    );
    assert.deepEqual(result.queries, [ s2('Country3', 'Role1') ]);
    assert.equal(result.relaxed, true);
  });

  it('keeps templates without placeholders if they have results, and excludes them otherwise', async() => {
    const template = 'SELECT ?v0 WHERE {\n\t?v0 <ex:p> ?v1 .\n}';
    const kept = await instantiateTemplate([ template, template ], async() => [], async() => 3, 5);
    assert.deepEqual(kept.queries, [ template ]);
    const excluded = await instantiateTemplate([ template, template ], async() => [], async() => 0, 5);
    assert.deepEqual(excluded.queries, []);
    assert.equal(excluded.relaxed, true);
  });
});
