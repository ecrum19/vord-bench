import { setTimeout as sleep } from 'node:timers/promises';
import { ConcurrencyGate, SlidingWindows } from './limiter.mjs';

/**
 * The safety layer protects upstreams, independently of the emulated restrictions.
 * Its limits are configured per upstream and kept per host, so members that share a host share them:
 * - rate: requests per window; requests over the rate wait (at most maxWaitMs, otherwise they are refused);
 * - concurrency: requests over the limit wait for a slot;
 * - budget: the total number of upstream requests while the proxy runs; requests beyond it are refused;
 * - breaker: after `threshold` responses with a listed status (or network errors) within a window, all requests to
 *   the host are refused until the breaker is closed on the admin port;
 * - the kill switch refuses all upstream requests and aborts the ones in flight, until resumed.
 * Refused requests never reach the upstream.
 */
export class SafetyLayer {
  /**
   * @param {Iterable<object>} upstreams Normalized upstreams.
   * @param {{ clock?: () => number }} [options]
   */
  constructor(upstreams, { clock = Date.now } = {}) {
    this.clock = clock;
    this.hosts = new Map();
    for (const upstream of upstreams) {
      if (!this.hosts.has(upstream.host)) {
        const safety = upstream.safety;
        this.hosts.set(upstream.host, {
          safety,
          windows: safety?.rate ? new SlidingWindows([{ limit: safety.rate.maxValue, durationMs: safety.rate.windowMs }]) : undefined,
          gate: safety?.concurrency ? new ConcurrencyGate(safety.concurrency) : undefined,
          used: 0,
          refused: {},
          errors: [],
          open: undefined,
        });
      }
    }
    this.killed = false;
    this.inFlight = new Set();
  }

  /**
   * Admit a request to an upstream, waiting if a limit requires it.
   * @param {object} upstream
   * @param {AbortSignal} [signal] Aborts waiting (when the client goes away).
   * @returns {Promise<{ ok: true, waitMs: number, signal: AbortSignal, release: () => void } |
   *   { ok: false, reason: string, waitMs: number }>}
   */
  async admit(upstream, signal) {
    const state = this.hosts.get(upstream.host);
    const start = this.clock();
    const refuse = reason => {
      state.refused[reason] = (state.refused[reason] ?? 0) + 1;
      return { ok: false, reason, waitMs: this.clock() - start };
    };
    const check = () => {
      if (this.killed) {
        return 'killed';
      }
      if (state.open) {
        return 'breaker';
      }
      if (state.safety?.budget !== undefined && state.used >= state.safety.budget) {
        return 'budget';
      }
    };
    let reason = check();
    if (reason) {
      return refuse(reason);
    }
    if (state.windows) {
      let wait;
      while ((wait = state.windows.waitTime(this.clock())) > 0) {
        if (this.clock() - start + wait > state.safety.maxWaitMs) {
          return refuse('rate');
        }
        await sleep(wait, undefined, { signal });
      }
    }
    if (state.gate) {
      await state.gate.acquire(signal);
    }
    // Limits may have been reached while waiting.
    reason = check();
    if (reason) {
      state.gate?.release();
      return refuse(reason);
    }
    state.windows?.record(this.clock());
    state.used++;
    const controller = new AbortController();
    this.inFlight.add(controller);
    let released = false;
    return {
      ok: true,
      waitMs: this.clock() - start,
      signal: controller.signal,
      release: () => {
        if (!released) {
          released = true;
          this.inFlight.delete(controller);
          state.gate?.release();
        }
      },
    };
  }

  /**
   * Record the outcome of an upstream request, for the breaker.
   * @param {object} upstream
   * @param {number | 'error'} status
   */
  report(upstream, status) {
    const state = this.hosts.get(upstream.host);
    const breaker = state.safety?.breaker;
    if (!breaker || !matchesStatus(breaker.statuses, status)) {
      return;
    }
    const now = this.clock();
    state.errors = state.errors.filter(time => time > now - breaker.windowMs);
    state.errors.push(now);
    if (state.errors.length >= breaker.threshold && !state.open) {
      state.open = { since: new Date(now).toISOString(), lastStatus: status, count: state.errors.length };
    }
  }

  kill() {
    this.killed = true;
    for (const controller of this.inFlight) {
      controller.abort(new Error('Stopped by the kill switch of vord-proxy'));
    }
  }

  resume() {
    this.killed = false;
  }

  /**
   * Close the breaker of a host (or of all hosts).
   * @param {string} [host]
   * @returns {number} The number of breakers closed.
   */
  close(host) {
    let closed = 0;
    for (const [ name, state ] of this.hosts) {
      if ((!host || host === name) && state.open) {
        state.open = undefined;
        state.errors = [];
        closed++;
      }
    }
    return closed;
  }

  /**
   * Whether the campaign must pause: the kill switch is on, or a breaker is open.
   */
  get tripped() {
    return this.killed || [ ...this.hosts.values() ].some(state => state.open);
  }

  status() {
    return {
      killed: this.killed,
      tripped: this.tripped,
      hosts: Object.fromEntries([ ...this.hosts ].map(([ host, state ]) => [ host, {
        limited: Boolean(state.safety),
        used: state.used,
        budget: state.safety?.budget,
        refused: state.refused,
        open: state.open,
      }])),
    };
  }
}

/**
 * @param {(number | string)[]} statuses Codes, or classes such as '5xx'.
 * @param {number | 'error'} status
 */
export function matchesStatus(statuses, status) {
  if (status === 'error') {
    return true;
  }
  return statuses.some(entry => typeof entry === 'number' ?
    entry === status :
    /^\dxx$/u.test(entry) && Math.floor(status / 100) === Number(entry[0]));
}
