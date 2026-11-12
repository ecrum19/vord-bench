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
   * @returns {Promise<void>}
   */
  acquire() {
    if (this.tryAcquire()) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiting.push(resolve));
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
