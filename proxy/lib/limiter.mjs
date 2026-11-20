/**
 * Sliding-window request counters.
 * A request is allowed at time `now` if, for every window, fewer than `limit` accepted requests
 * happened in (now - durationMs, now].
 */
export class SlidingWindows {
  /**
   * @param {{ limit: number, durationMs: number }[]} windows
   */
  constructor(windows) {
    this.windows = windows;
    this.maxDurationMs = Math.max(0, ...windows.map(window => window.durationMs));
    this.timestamps = [];
  }

  /**
   * Build the windows of a set of normalized rate and quota restrictions.
   * Each restriction allows maxValue requests per window.
   * A burstValue below maxValue additionally allows at most burstValue requests
   * within windowMs * burstValue / maxValue, i.e. bursts at the same average rate.
   * This is the same interpretation as Comunica's limit-restrictions actor.
   * @param {object[]} restrictions Normalized restrictions.
   * @returns {SlidingWindows | undefined}
   */
  static fromRestrictions(restrictions) {
    const windows = [];
    for (const restriction of restrictions) {
      if (!(restriction.maxValue > 0) || !(restriction.windowMs > 0)) {
        continue;
      }
      windows.push({ limit: restriction.maxValue, durationMs: restriction.windowMs });
      if (restriction.burstValue > 0 && restriction.burstValue < restriction.maxValue) {
        windows.push({
          limit: restriction.burstValue,
          durationMs: restriction.windowMs * restriction.burstValue / restriction.maxValue,
        });
      }
    }
    return windows.length > 0 ? new SlidingWindows(windows) : undefined;
  }

  /**
   * @param {number} now
   * @returns {number} The number of milliseconds until a request would be allowed (0 if allowed now).
   */
  waitTime(now) {
    this.prune(now);
    let wait = 0;
    for (const { limit, durationMs } of this.windows) {
      const inWindow = this.timestamps.filter(timestamp => timestamp > now - durationMs);
      if (inWindow.length >= limit) {
        wait = Math.max(wait, inWindow[inWindow.length - limit] + durationMs - now);
      }
    }
    return wait;
  }

  /**
   * Record an accepted request.
   * @param {number} now
   */
  record(now) {
    this.timestamps.push(now);
  }

  prune(now) {
    const threshold = now - this.maxDurationMs;
    let index = 0;
    while (index < this.timestamps.length && this.timestamps[index] <= threshold) {
      index++;
    }
    if (index > 0) {
      this.timestamps.splice(0, index);
    }
  }
}

/**
 * A counter of in-flight requests with a maximum, with an optional FIFO queue.
 */
export class ConcurrencyGate {
  /**
   * @param {number} limit
   */
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  /**
   * @returns {boolean} If a slot was taken.
   */
  tryAcquire() {
    if (this.active < this.limit) {
      this.active++;
      return true;
    }
    return false;
  }

  /**
   * Wait for a slot.
   * @param {AbortSignal} [signal] Stops waiting, rejecting with the signal's reason.
   * @returns {Promise<void>}
   */
  acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.tryAcquire()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) {
      // Hand the slot over directly, so that the number of active requests stays the same.
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }
}

const MODES = { RejectRequest: 'reject', QueueRequest: 'queue', ThrottleResponse: 'throttle' };

/**
 * The emulation of one rate or quota restriction, with its own sliding windows and enforcement:
 * - reject: a request over the limit is rejected (and not counted);
 * - queue: a request over the limit waits for its turn, as nginx's limit_req does; with emulation.queueLimit,
 *   requests beyond that many waiting ones are rejected;
 * - throttle: every request is counted, and one over the limit is delayed by emulation.delayPerExcessMs times the
 *   number of requests by which the client exceeds the limit, as slow-down middleware does (a tarpit).
 * With emulation.background, other tenants use part of the limit (a limit shared by all users): their share is a
 * random walk between 0 and background.maxShare of the limit, redrawn every background.stepMs.
 */
export class RateLimiter {
  /**
   * @param {object} restriction A normalized rate or quota restriction.
   * @param {() => number} [random] The random generator of the background tenants.
   */
  constructor(restriction, random = Math.random) {
    this.restriction = restriction;
    this.mode = MODES[restriction.enforcement] ?? 'reject';
    this.windows = SlidingWindows.fromRestrictions([ restriction ]);
    this.queueLimit = restriction.emulation.queueLimit;
    this.delayPerExcessMs = restriction.emulation.delayPerExcessMs ?? 0;
    const background = restriction.emulation.background;
    if (background) {
      this.background = {
        maxShare: background.maxShare ?? 0.75,
        stepMs: background.stepMs ?? 5_000,
        random,
        start: undefined,
        shares: [],
      };
    }
  }

  /**
   * The share of the limit that background tenants use at a time.
   * @param {number} now
   */
  backgroundShare(now) {
    const background = this.background;
    background.start ??= now;
    const step = Math.max(0, Math.floor((now - background.start) / background.stepMs));
    while (background.shares.length <= step) {
      const previous = background.shares.at(-1) ?? background.random() * background.maxShare;
      const next = previous + ((background.random() - 0.5) * background.maxShare * 2 / 3);
      background.shares.push(Math.min(background.maxShare, Math.max(0, next)));
    }
    return background.shares[step];
  }

  /**
   * Apply the background tenants to the main window.
   * @param {number} now
   */
  applyBackground(now) {
    if (this.background && this.windows) {
      const main = this.windows.windows[0];
      main.limit = Math.max(1, Math.round(this.restriction.maxValue * (1 - this.backgroundShare(now))));
    }
  }

  /**
   * @param {number} now
   * @returns {number} The milliseconds until a request would fit (0 if it fits now).
   */
  waitTime(now) {
    if (!this.windows) {
      return 0;
    }
    this.applyBackground(now);
    return this.windows.waitTime(now);
  }

  /**
   * Record an accepted request.
   * @param {number} now
   */
  record(now) {
    this.windows?.record(now);
  }

  /**
   * Reserve the earliest time at which a request fits (queue mode).
   * @param {number} now
   * @returns {{ time: number, waiting: number }} The reserved time, and the number of requests waiting, including
   *   this one.
   */
  reserve(now) {
    const time = Math.max(now + this.waitTime(now), this.windows.timestamps.at(-1) ?? now);
    this.windows.record(time);
    return { time, waiting: this.windows.timestamps.filter(timestamp => timestamp > now).length };
  }

  /**
   * Cancel the last reservation.
   */
  cancelLast() {
    this.windows.timestamps.pop();
  }

  /**
   * Count a request and determine its delay (throttle mode).
   * @param {number} now
   * @returns {number} The delay in milliseconds.
   */
  throttle(now) {
    if (!this.windows) {
      return 0;
    }
    this.windows.prune(now);
    this.windows.record(now);
    const { limit, durationMs } = this.windows.windows[0];
    const count = this.windows.timestamps.filter(timestamp => timestamp > now - durationMs).length;
    return Math.max(0, count - limit) * this.delayPerExcessMs;
  }
}

/**
 * A usage budget of cost units: a bucket of `capacity` units (burstValue, or else maxValue), refilled at
 * maxValue per window. Requests pay their base cost on arrival and the cost of their results on completion,
 * which may take the bucket below zero.
 */
export class TokenBucket {
  /**
   * @param {object} restriction A normalized cost model restriction with metric costUnitsPerWindow.
   * @param {number} now
   */
  constructor(restriction, now) {
    this.restriction = restriction;
    this.capacity = restriction.burstValue ?? restriction.maxValue;
    this.refillPerMs = restriction.maxValue / restriction.windowMs;
    this.units = this.capacity;
    this.updatedAt = now;
    const cost = restriction.emulation.cost ?? {};
    this.cost = { base: cost.base ?? 1, aggregate: cost.aggregate ?? 0, rowsPerUnit: cost.rowsPerUnit ?? 0 };
  }

  refill(now) {
    this.units = Math.min(this.capacity, this.units + (Math.max(0, now - this.updatedAt) * this.refillPerMs));
    this.updatedAt = Math.max(this.updatedAt, now);
  }

  /**
   * The cost of a request that is charged on arrival.
   * @param {string} query
   */
  baseCost(query) {
    return this.cost.base + (/\b(?:COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|SAMPLE)\s*\(/iu.test(query) ? this.cost.aggregate : 0);
  }

  /**
   * Charge the base cost of a request on arrival.
   * @param {number} cost
   * @param {number} now
   * @returns {number} 0 if the request was charged, or else the milliseconds until the budget can pay for it.
   */
  charge(cost, now) {
    this.refill(now);
    if (this.units < cost) {
      return Math.ceil((cost - this.units) / this.refillPerMs);
    }
    this.units -= cost;
    return 0;
  }

  /**
   * Charge the cost of the results of a request on completion.
   * @param {number} rows
   * @param {number} now
   * @returns {number} The charged cost.
   */
  chargeRows(rows, now) {
    const cost = this.cost.rowsPerUnit > 0 ? Math.floor(rows / this.cost.rowsPerUnit) : 0;
    this.refill(now);
    this.units -= cost;
    return cost;
  }

  /**
   * The headers that report the budget, as OpenAlex and GitHub do.
   * @param {number} cost The cost of the request.
   * @param {number} now
   */
  headers(cost, now) {
    this.refill(now);
    const remaining = String(Math.max(0, Math.floor(this.units)));
    return {
      'x-ratelimit-limit': String(this.restriction.maxValue),
      'x-ratelimit-remaining': remaining,
      'x-ratelimit-credits-used': String(cost),
      'x-ratelimit-reset': String(Math.ceil((this.capacity - this.units) / this.refillPerMs / 1_000)),
      ...this.restriction.signalHeader ? { [this.restriction.signalHeader]: remaining } : {},
    };
  }
}
