import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScanner, isScannable, mediaType, scanAll } from '../proxy/lib/scanner.mjs';

/**
 * Feed a text to a scanner in pieces of a given size, as a streaming response would arrive.
 */
function feed(contentType, limit, text, size) {
  const scanner = createScanner(contentType, limit);
  let out = '';
  for (let i = 0; i < text.length && !scanner.done; i += size) {
    out += scanner.push(text.slice(i, i + size));
  }
  if (!scanner.done) {
    out += scanner.end();
  }
  return { out, rows: scanner.rows, truncated: scanner.truncated, done: scanner.done };
}

/**
 * Check a scanner on every piece size from 1 to the whole text: the outcome must not depend on how the text arrives.
 */
function check(contentType, limit, text, expected) {
  for (const size of [ 1, 2, 3, 5, 7, 13, text.length ]) {
    const { out, rows, truncated } = feed(contentType, limit, text, size);
    assert.equal(out, expected.out, `output with pieces of ${size}`);
    assert.equal(rows, expected.rows, `rows with pieces of ${size}`);
    assert.equal(truncated, expected.truncated, `truncated with pieces of ${size}`);
  }
}

const jsonResults = count => JSON.stringify({
  head: { vars: [ 'o' ]},
  results: {
    bindings: Array.from({ length: count }, (_, i) => ({
      o: { type: 'literal', value: `v${i} {"tricky": [1, 2]} \\" ,` },
    })),
  },
});

describe('streaming scanners', () => {
  it('recognizes media types', () => {
    assert.equal(mediaType('application/sparql-results+json; charset=utf-8'), 'application/sparql-results+json');
    assert.equal(isScannable('text/csv'), true);
    assert.equal(isScannable('text/turtle'), false);
  });

  it('counts SPARQL JSON results without changing them', () => {
    const text = jsonResults(4);
    check('application/sparql-results+json', undefined, text, { out: text, rows: 4, truncated: false });
    check('application/sparql-results+json', 4, text, { out: text, rows: 4, truncated: false });
  });

  it('truncates SPARQL JSON results to valid JSON, independent of piece boundaries', () => {
    const text = jsonResults(5);
    const { out } = feed('application/sparql-results+json', 2, text, text.length);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.results.bindings, JSON.parse(text).results.bindings.slice(0, 2));
    assert.deepEqual(parsed.head, { vars: [ 'o' ]});
    check('application/sparql-results+json', 2, text, { out, rows: 2, truncated: true });
  });

  it('truncates SPARQL JSON results with whitespace and members before and after the bindings', () => {
    const text = '{\n  "head": {"vars": ["x"]},\n  "results": {\n    "distinct": false,\n    "bindings": [\n' +
      '      {"x": {"type": "uri", "value": "a"}},\n      {"x": {"type": "uri", "value": "b"}}\n    ],\n' +
      '    "extra": {"nested": {}}\n  },\n  "tail": [ {} ]\n}\n';
    check('application/sparql-results+json', 5, text, { out: text, rows: 2, truncated: false });
    check('application/sparql-results+json', 2, text, { out: text, rows: 2, truncated: false });
    const { out } = feed('application/sparql-results+json', 1, text, 4);
    assert.deepEqual(JSON.parse(out).results.bindings, [{ x: { type: 'uri', value: 'a' }}]);
    assert.equal(JSON.parse(out).results.distinct, false);
  });

  it('allows no SPARQL JSON results with a limit of 0', () => {
    const { out, rows, truncated } = feed('application/sparql-results+json', 0, jsonResults(2), 3);
    assert.deepEqual(JSON.parse(out).results.bindings, []);
    assert.deepEqual({ rows, truncated }, { rows: 0, truncated: true });
    const empty = jsonResults(0);
    check('application/sparql-results+json', 0, empty, { out: empty, rows: 0, truncated: false });
  });

  it('passes ASK results through without counting', () => {
    const text = '{ "head": {}, "boolean": true }';
    check('application/sparql-results+json', 1, text, { out: text, rows: undefined, truncated: false });
  });

  it('counts and truncates SPARQL XML results', () => {
    const result = i => `  <result><binding name="o"><literal>a &lt;result&gt; ${i}</literal></binding></result>\n`;
    const text = '<?xml version="1.0"?>\n<sparql xmlns="http://www.w3.org/2005/sparql-results#">\n' +
      '<head><variable name="o"/></head>\n<results>\n' + [ 0, 1, 2 ].map(result).join('') + '</results>\n</sparql>\n';
    check('application/sparql-results+xml', undefined, text, { out: text, rows: 3, truncated: false });
    check('application/sparql-results+xml', 3, text, { out: text, rows: 3, truncated: false });
    // Cut right after the last allowed </result>.
    const expected = text.slice(0, text.indexOf(result(2)) - 1) + '\n</results>\n</sparql>\n';
    check('application/sparql-results+xml', 2, text, { out: expected, rows: 2, truncated: true });
    const ask = '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head/><boolean>true</boolean></sparql>';
    check('application/sparql-results+xml', 1, ask, { out: ask, rows: undefined, truncated: false });
  });

  it('counts and truncates SPARQL TSV results after the header', () => {
    const text = '?a\t?b\n<x>\t"1"\n\t"2"\n<z>\t\n';
    check('text/tab-separated-values', undefined, text, { out: text, rows: 3, truncated: false });
    check('text/tab-separated-values', 2, text, { out: '?a\t?b\n<x>\t"1"\n\t"2"\n', rows: 2, truncated: true });
    check('text/tab-separated-values', 0, text, { out: '?a\t?b\n', rows: 0, truncated: true });
    check('text/tab-separated-values', 3, '?a\n<x>\n<y>\n<z>', { out: '?a\n<x>\n<y>\n<z>', rows: 3, truncated: false });
  });

  it('counts CSV records with line breaks inside quotes', () => {
    const text = 'a,b\r\n"x\r\ny",1\r\nz,"2 ""quoted"""\r\nw,3\r\n';
    check('text/csv', undefined, text, { out: text, rows: 3, truncated: false });
    check('text/csv', 2, text, { out: 'a,b\r\n"x\r\ny",1\r\nz,"2 ""quoted"""\r\n', rows: 2, truncated: true });
  });

  it('counts and truncates N-Triples, ignoring blank lines and comments', () => {
    const text = '# comment\n<a> <b> <c> .\n\n<a> <b> <d> .\n# more\n<a> <b> <e> .\n';
    check('application/n-triples', undefined, text, { out: text, rows: 3, truncated: false });
    check('application/n-triples', 2, text, { out: '# comment\n<a> <b> <c> .\n\n<a> <b> <d> .\n', rows: 2, truncated: true });
    check('application/n-triples', 3, text, { out: text, rows: 3, truncated: false });
    check('application/n-triples', 0, text, { out: '', rows: 0, truncated: true });
  });

  it('passes unknown formats through', () => {
    check('text/turtle', 1, '<a> <b> <c>, <d> .', { out: '<a> <b> <c>, <d> .', rows: undefined, truncated: false });
  });

  it('scans complete bodies', () => {
    assert.deepEqual(scanAll('<a> <b> <c> .\n<a> <b> <d> .\n', 'application/n-triples', 1),
      { body: '<a> <b> <c> .\n', rows: 1, truncated: true });
  });
});
