import { SlidingWindows } from './limiter.mjs';
import { normalizeRestriction } from './profiles.mjs';

/**
 * Checks the requests that clients send against the published policy of an upstream, without enforcing it:
 * the politeness metric counts the requests that the real endpoint would have refused.
 *
 * Only hard restrictions are checked:
 * - rate and quota: a request is a violation if the policy's windows are full (only allowed requests are counted,
 *   as an endpoint would);
 * - concurrency: a violation if more requests to the host are in flight;
 * - response time: a violation if the upstream took longer than the policy allows (checked after the response).
 * State is kept per host and cleared at the start of every run.
 */
export class PolicyMonitor {
  /**
   * @param {{ clock?: () => number }} [options]
   */
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.hosts = new Map();
  }

  reset() {
    this.hosts.clear();
  }

  state(upstream) {
    let state = this.hosts.get(upstream.host);
    if (!state) {
      const hard = upstream.policy.restrictions.map(normalizeRestriction).filter(restriction => restriction.hard);
      const rates = hard.filter(restriction => [ 'RateRestriction', 'QuotaRestriction' ].includes(restriction.type));
      const concurrency = hard.filter(restriction => restriction.type === 'ConcurrentRequestsRestriction');
      const responseTime = hard.filter(restriction => restriction.type === 'ResponseTimeRestriction');
      state = {
        windows: SlidingWindows.fromRestrictions(rates),
        concurrency: concurrency.length > 0 ? Math.min(...concurrency.map(restriction => restriction.maxValue)) : undefined,
        timeoutMs: responseTime.length > 0 ? Math.min(...responseTime.map(restriction => restriction.maxValue)) * 1_000 : undefined,
        active: 0,
      };
      this.hosts.set(upstream.host, state);
    }
    return state;
  }

  /**
   * Check a request when it arrives.
   * @param {object} upstream
   * @returns {{ violations: string[], done: (upstreamMs?: number) => string[] }}
   *   The violations on arrival; call done when the request ends, which returns the violations after the response.
   */
  arrive(upstream) {
    if (!upstream.policy) {
      return { violations: [], done: () => [] };
    }
    const state = this.state(upstream);
    const violations = [];
    const now = this.clock();
    if (state.windows) {
      if (state.windows.waitTime(now) > 0) {
        violations.push('rate');
      } else {
        state.windows.record(now);
      }
    }
    if (state.concurrency !== undefined && state.active >= state.concurrency) {
      violations.push('concurrency');
    }
    state.active++;
    let ended = false;
    return {
      violations,
      done: upstreamMs => {
        if (ended) {
          return [];
        }
        ended = true;
        state.active--;
        return state.timeoutMs !== undefined && upstreamMs !== undefined && upstreamMs > state.timeoutMs ?
          [ 'responseTime' ] :
          [];
      },
    };
  }
}
