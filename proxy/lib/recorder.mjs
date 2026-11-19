import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Records upstream responses, and replays them.
 * - record: every upstream response is stored, per member, query and requested media type.
 * - replay: stored responses are served with their recorded upstream latency; a miss is forwarded and recorded.
 * Replays are meant for debugging and for estimating client-side variance, not for primary results,
 * because they hide the upstream's variance.
 */
export class Recorder {
  /**
   * @param {{ mode: 'off' | 'record' | 'replay', dir?: string, maxBytes?: number }} options
   */
  constructor({ mode = 'off', dir, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.mode = mode;
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.counts = { hits: 0, misses: 0, stored: 0, skipped: 0 };
  }

  get recording() {
    return this.mode === 'record' || this.mode === 'replay';
  }

  /**
   * The key of a request. Queries are only normalized for line endings and surrounding whitespace,
   * so that different queries never share a key.
   */
  static key(member, query, accept) {
    const normalized = query.replaceAll('\r\n', '\n').trim();
    return createHash('sha256').update(`${member}\n${accept}\n${normalized}`).digest('hex');
  }

  path(member, key) {
    return join(this.dir, member, `${key}.json`);
  }

  /**
   * Look up a recorded response (replay mode only).
   * @returns {Promise<{ status: number, contentType: string, body: string, upstreamMs: number } | undefined>}
   */
  async lookup(member, query, accept) {
    if (this.mode !== 'replay') {
      return undefined;
    }
    try {
      const entry = JSON.parse(await readFile(this.path(member, Recorder.key(member, query, accept)), 'utf8'));
      this.counts.hits++;
      return entry;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.counts.misses++;
      return undefined;
    }
  }

  /**
   * Store an upstream response (record mode, and misses in replay mode).
   * Responses larger than maxBytes are not stored.
   * @param {string} member
   * @param {string} query
   * @param {string} accept
   * @param {{ status: number, contentType: string, body: Buffer, upstreamMs: number }} response
   * @returns {Promise<boolean>} Whether the response was stored.
   */
  async store(member, query, accept, { status, contentType, body, upstreamMs }) {
    if (!this.recording) {
      return false;
    }
    if (body.length > this.maxBytes) {
      this.counts.skipped++;
      return false;
    }
    const key = Recorder.key(member, query, accept);
    const path = this.path(member, key);
    await mkdir(join(this.dir, member), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({
      member,
      accept,
      query,
      status,
      contentType,
      upstreamMs: Math.round(upstreamMs),
      recordedAt: new Date().toISOString(),
      body: body.toString('utf8'),
    }));
    await rename(temporary, path);
    this.counts.stored++;
    return true;
  }

  status() {
    return { mode: this.mode, dir: this.dir, ...this.counts };
  }
}
