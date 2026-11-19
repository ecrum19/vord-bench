/**
 * Streaming scanners of SPARQL results: they count the results of a response while it streams through the proxy,
 * and cut it off after a number of results, so that the rest is never read from the upstream.
 *
 * Every scanner has the same interface:
 * - push(text) takes the next decoded piece of the response and returns the text to pass on.
 *   Once `done` is true, the response was truncated and the rest of the upstream response can be dropped.
 * - end() returns the text that was held back, at the end of the upstream response.
 * - rows is the number of results so far, or undefined for responses without results (ASK, unknown formats).
 * - truncated is true if results were cut off.
 *
 * A response is only truncated if it has more than `limit` results: after the last allowed result,
 * the scanner holds the following text back until it knows whether another result follows.
 */

/**
 * Create a scanner for a content type.
 * Supported: SPARQL JSON, SPARQL XML, SPARQL TSV and CSV, N-Triples and N-Quads.
 * Other content types pass through without counting.
 * @param {string} contentType
 * @param {number | undefined} limit The maximum number of results to pass on (undefined: no limit).
 */
export function createScanner(contentType, limit) {
  switch (mediaType(contentType)) {
    case 'application/sparql-results+json':
    case 'application/json':
      return new JsonResultsScanner(limit);
    case 'application/sparql-results+xml':
    case 'application/xml':
      return new XmlResultsScanner(limit);
    case 'text/tab-separated-values':
      return new LineScanner(limit, { header: true });
    case 'text/csv':
      return new LineScanner(limit, { header: true, quotes: true });
    case 'application/n-triples':
    case 'application/n-quads':
      return new LineScanner(limit, { comments: true });
    default:
      return new PassThroughScanner();
  }
}

/**
 * The media type of a Content-Type header, without parameters.
 * @param {string} contentType
 */
export function mediaType(contentType) {
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Whether the scanners understand a content type.
 * @param {string} contentType
 */
export function isScannable(contentType) {
  return !(createScanner(contentType, undefined) instanceof PassThroughScanner);
}

/**
 * Scan a complete response body.
 * @param {string} body
 * @param {string} contentType
 * @param {number | undefined} limit
 * @returns {{ body: string, rows: number | undefined, truncated: boolean }}
 */
export function scanAll(body, contentType, limit) {
  const scanner = createScanner(contentType, limit);
  const out = scanner.push(body) + (scanner.done ? '' : scanner.end());
  return { body: out, rows: scanner.rows, truncated: scanner.truncated };
}

class PassThroughScanner {
  rows = undefined;
  truncated = false;
  done = false;

  push(text) {
    return text;
  }

  end() {
    return '';
  }
}

/**
 * Shared state: the text after the last allowed result is held back until the next token decides
 * whether another result follows.
 */
class LimitedScanner {
  constructor(limit) {
    this.limit = limit;
    this.rows = undefined;
    this.truncated = false;
    this.done = false;
    this.held = undefined;
  }

  atLimit() {
    return this.limit !== undefined && (this.rows ?? 0) >= this.limit;
  }

  /**
   * Record the end of a result. Returns true if no further results may be passed on.
   */
  countRow() {
    this.rows = (this.rows ?? 0) + 1;
    return this.atLimit();
  }

  /**
   * Stop: the response is cut off here.
   * @param {string} out The text to pass on before the closing text.
   * @param {string} closing
   */
  cut(out, closing) {
    this.truncated = true;
    this.done = true;
    this.held = undefined;
    return out + closing;
  }
}

/**
 * Counts the elements of results.bindings in SPARQL JSON results.
 * Truncated output closes the bindings array and all enclosing objects, so it stays valid JSON.
 * Members after "bindings" are dropped; endpoints write "head" before "results".
 */
export class JsonResultsScanner extends LimitedScanner {
  constructor(limit) {
    super(limit);
    // The open containers, outermost first.
    this.stack = [];
    this.inString = false;
    this.escape = false;
    // The key being read, for the keys of the two outer objects.
    this.capture = undefined;
    this.inBindings = false;
  }

  push(text) {
    if (this.done) {
      return '';
    }
    let out = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
          if (this.capture !== undefined) {
            this.capture += char;
          }
        } else if (char === '\\') {
          this.escape = true;
        } else if (char === '"') {
          this.inString = false;
          if (this.capture !== undefined) {
            this.stack.at(-1).lastString = this.capture;
            this.capture = undefined;
          }
        } else if (this.capture !== undefined) {
          this.capture += char;
        }
        continue;
      }
      if (this.held !== undefined && !/\s/u.test(char)) {
        // Another result follows: "," after a result, or "{" if no results are allowed at all.
        if (char === ',' || char === '{') {
          return this.cut(out, this.closing());
        }
        // Anything else ("]") ends the held back text.
        out += this.held;
        this.held = undefined;
      }
      const top = this.stack.at(-1);
      switch (char) {
        case '"':
          this.inString = true;
          this.capture = top && !top.array && top.expectKey && this.stack.length <= 2 ? '' : undefined;
          break;
        case ':':
          if (top && !top.array) {
            top.key = top.lastString;
            top.expectKey = false;
          }
          break;
        case ',':
          if (top && !top.array) {
            top.expectKey = true;
          }
          break;
        case '{':
        case '[':
          this.stack.push({ array: char === '[', key: undefined, expectKey: char === '{', lastString: undefined });
          if (char === '[' && this.stack.length === 3 && this.stack[0].key === 'results' &&
            this.stack[1].key === 'bindings') {
            this.inBindings = true;
            this.rows = 0;
            if (this.atLimit()) {
              out += text.slice(start, i + 1);
              this.held = '';
              start = i + 1;
            }
          }
          break;
        case '}':
        case ']':
          this.stack.pop();
          if (this.inBindings && char === ']' && this.stack.length === 2) {
            this.inBindings = false;
          } else if (this.inBindings && char === '}' && this.stack.length === 3 && this.countRow()) {
            out += text.slice(start, i + 1);
            this.held = '';
            start = i + 1;
          }
          break;
        default:
      }
    }
    return this.flush(out, text.slice(start));
  }

  flush(out, rest) {
    if (this.held === undefined) {
      return out + rest;
    }
    this.held += rest;
    return out;
  }

  closing() {
    return this.stack.map(container => container.array ? ']' : '}').reverse().join('');
  }

  end() {
    const rest = this.held ?? '';
    this.held = undefined;
    return rest;
  }
}

const XML_TAGS = /<results[\s>/]|<\/results>|<result[\s>/]|<\/result>/gu;
const XML_CLOSING = '\n</results>\n</sparql>\n';

/**
 * Counts the <result> elements of SPARQL XML results.
 * Truncated output closes the results and sparql elements.
 */
export class XmlResultsScanner extends LimitedScanner {
  constructor(limit) {
    super(limit);
    // The end of the previous piece, if it may be the start of a tag.
    this.pending = '';
  }

  push(text) {
    if (this.done) {
      return '';
    }
    const buffer = this.pending + text;
    // The longest tag is 10 characters; keep an unfinished tag at the end for the next piece.
    const lastOpen = buffer.lastIndexOf('<');
    const safeEnd = lastOpen >= 0 && buffer.length - lastOpen < 10 && !buffer.includes('>', lastOpen) ?
      lastOpen :
      buffer.length;
    const scan = buffer.slice(0, safeEnd);
    this.pending = buffer.slice(safeEnd);
    let out = '';
    let start = 0;
    for (const match of scan.matchAll(XML_TAGS)) {
      const tag = match[0];
      const isResults = tag.startsWith('<results');
      if (this.held !== undefined) {
        if (tag.startsWith('<result') && !isResults) {
          this.pending = '';
          return this.cut(out, XML_CLOSING);
        }
        if (tag === '</results>') {
          out += this.held;
          this.held = undefined;
        }
        continue;
      }
      if (isResults) {
        this.rows = 0;
        if (this.atLimit()) {
          const end = scan.indexOf('>', match.index) + 1 || scan.length;
          out += scan.slice(start, end);
          this.held = '';
          start = end;
        }
      } else if (tag === '</result>' && this.countRow()) {
        const end = match.index + tag.length;
        out += scan.slice(start, end);
        this.held = '';
        start = end;
      }
    }
    if (this.held === undefined) {
      return out + scan.slice(start);
    }
    this.held += scan.slice(start);
    return out;
  }

  end() {
    const rest = (this.held ?? '') + this.pending;
    this.held = undefined;
    this.pending = '';
    return rest;
  }
}

/**
 * Counts the records of line-based formats:
 * - SPARQL TSV and CSV: every non-empty line after the header line; CSV fields may contain line breaks in quotes.
 *   (A row of a single unbound variable is an empty line, and is not counted.)
 * - N-Triples and N-Quads: every line that is not blank and not a comment.
 */
export class LineScanner extends LimitedScanner {
  /**
   * @param {number | undefined} limit
   * @param {{ header?: boolean, quotes?: boolean, comments?: boolean }} options
   */
  constructor(limit, { header = false, quotes = false, comments = false } = {}) {
    super(limit);
    this.rows = 0;
    this.header = header;
    this.quotes = quotes;
    this.comments = comments;
    this.inQuotes = false;
    // What the current line is, once its first significant character is known: 'record' or 'other'.
    this.line = undefined;
    if (!header && this.atLimit()) {
      this.held = '';
    }
  }

  classify(char) {
    if (this.comments) {
      if (/\s/u.test(char)) {
        return undefined;
      }
      return char === '#' ? 'other' : 'record';
    }
    return char === '\r' ? undefined : 'record';
  }

  push(text) {
    if (this.done) {
      return '';
    }
    let out = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '\n' && !this.inQuotes) {
        const wasHeader = this.header;
        const record = !wasHeader && this.line === 'record';
        this.header = false;
        this.line = undefined;
        if (record) {
          this.rows++;
        }
        if (this.held === undefined && (record || wasHeader) && this.atLimit()) {
          out += text.slice(start, i + 1);
          this.held = '';
          start = i + 1;
        }
        continue;
      }
      if (this.quotes && char === '"') {
        this.inQuotes = !this.inQuotes;
      }
      if (this.line === undefined) {
        this.line = this.classify(char);
        if (this.line === 'record' && this.held !== undefined) {
          return this.cut(out, '');
        }
      }
    }
    if (this.held === undefined) {
      return out + text.slice(start);
    }
    this.held += text.slice(start);
    return out;
  }

  end() {
    // A last record without a line break.
    if (!this.header && this.line === 'record') {
      this.rows++;
    }
    this.line = undefined;
    const rest = this.held ?? '';
    this.held = undefined;
    return rest;
  }
}
