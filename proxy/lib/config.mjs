import { durationToMs } from './duration.mjs';
import { validateRestriction } from './profiles.mjs';

export const DESCRIPTION_MODES = [ 'advertised', 'provided', 'none' ];
export const DEFAULT_RUN_HEADER = 'x-vord-bench-run';
const BREAKER_STATUSES = [ 403, 429, '5xx' ];

/**
 * Read and check a proxy configuration (the endpoints file of a suite).
 *
 * Every federation member ("endpoint") listens on its own port and forwards to an upstream.
 * An upstream is either given as a URL, or as the name of an entry of `upstreams`, which configures how it is queried,
 * its safety limits and its published policy. Members that share an upstream share its safety limits.
 *
 * @param {object} raw The parsed JSON configuration.
 * @returns {object} The normalized configuration.
 */
export function normalizeConfig(raw) {
  const fail = message => {
    throw new Error(`Proxy configuration: ${message}`);
  };
  if (!raw.endpoints || Object.keys(raw.endpoints).length === 0) {
    fail('no endpoints');
  }
  const upstreams = new Map();
  for (const [ name, entry ] of Object.entries(raw.upstreams ?? {})) {
    upstreams.set(name, normalizeUpstream(name, entry, fail));
  }
  const members = {};
  const ports = new Map([[ raw.adminPort, 'admin' ]]);
  for (const [ name, entry ] of Object.entries(raw.endpoints)) {
    if (!/^[\w-]+$/u.test(name)) {
      fail(`endpoint name ${name} must be URL-safe`);
    }
    if (!Number.isInteger(entry.port) || entry.port < 0) {
      fail(`endpoint ${name} needs a port`);
    }
    if (entry.port !== 0 && ports.has(entry.port)) {
      fail(`endpoints ${ports.get(entry.port)} and ${name} share port ${entry.port}`);
    }
    ports.set(entry.port, name);
    let upstream;
    if (typeof entry.upstream === 'string' && entry.upstream.includes('://')) {
      // An upstream given by URL; members with the same URL share it.
      upstream = upstreams.get(entry.upstream) ?? normalizeUpstream(entry.upstream, { url: entry.upstream }, fail);
      upstreams.set(entry.upstream, upstream);
    } else {
      upstream = upstreams.get(entry.upstream);
      if (!upstream) {
        fail(`endpoint ${name} refers to an unknown upstream ${entry.upstream}`);
      }
    }
    members[name] = {
      name,
      port: entry.port,
      upstream,
      defaultGraph: entry.defaultGraph,
      aliases: entry.aliases ?? [],
      group: entry.group,
    };
  }
  // Safety limits are kept per host: upstreams on the same host must agree on them.
  const safetyByHost = new Map();
  for (const upstream of upstreams.values()) {
    if (raw.requireSafety && !upstream.safety) {
      fail(`upstream ${upstream.name} has no safety limits, which requireSafety demands`);
    }
    const key = upstream.host;
    const safety = JSON.stringify(upstream.safety ?? null);
    if (safetyByHost.has(key) && safetyByHost.get(key) !== safety) {
      fail(`upstreams on host ${key} have different safety limits`);
    }
    safetyByHost.set(key, safety);
  }
  return {
    adminPort: raw.adminPort,
    latencyMs: raw.latencyMs ?? 0,
    publicBaseUrl: raw.publicBaseUrl ?? 'http://localhost',
    runHeader: (raw.runHeader ?? DEFAULT_RUN_HEADER).toLowerCase(),
    requireSafety: Boolean(raw.requireSafety),
    recording: normalizeRecording(raw.recording, fail),
    upstreams,
    members,
  };
}

function normalizeUpstream(name, entry, fail) {
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    fail(`upstream ${name} needs a valid url`);
  }
  const method = (entry.method ?? 'POST').toUpperCase();
  if (![ 'GET', 'POST' ].includes(method)) {
    fail(`upstream ${name}: method must be GET or POST`);
  }
  const headers = Object.fromEntries(Object.entries(entry.headers ?? {})
    .map(([ header, value ]) => [ header.toLowerCase(), String(value) ]));
  if (entry.timeoutParameter && (typeof entry.timeoutParameter.name !== 'string' ||
    !/\{m?s\}/u.test(entry.timeoutParameter.value ?? ''))) {
    fail(`upstream ${name}: timeoutParameter needs a name and a value with {ms} or {s}`);
  }
  const serviceDescription = entry.serviceDescription ?? 'generated';
  if (![ 'generated', 'passthrough' ].includes(serviceDescription)) {
    fail(`upstream ${name}: serviceDescription must be generated or passthrough`);
  }
  const policy = entry.policy ? normalizePolicy(name, entry.policy, fail) : undefined;
  const safety = entry.safety ? normalizeSafety(name, entry.safety, headers, fail) : undefined;
  return {
    name,
    url: url.href,
    host: url.host,
    method,
    headers,
    accept: entry.accept ?? {},
    timeoutParameter: entry.timeoutParameter,
    serviceDescription,
    policy,
    safety,
  };
}

function normalizePolicy(name, policy, fail) {
  if (!Array.isArray(policy.restrictions)) {
    fail(`upstream ${name}: policy needs a list of restrictions`);
  }
  for (const restriction of policy.restrictions) {
    validateRestriction(restriction, `upstream ${name} policy`);
  }
  return { source: policy.source, retrieved: policy.retrieved, restrictions: policy.restrictions };
}

function normalizeSafety(name, safety, headers, fail) {
  const positive = (value, field) => {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      fail(`upstream ${name}: safety.${field} must be a positive number`);
    }
    return value;
  };
  let rate;
  if (safety.rate) {
    rate = {
      maxValue: positive(safety.rate.maxValue, 'rate.maxValue'),
      windowMs: durationToMs(safety.rate.windowDuration),
    };
    if (rate.maxValue === undefined || rate.windowMs === undefined) {
      fail(`upstream ${name}: safety.rate needs a maxValue and a windowDuration`);
    }
  }
  let breaker;
  if (safety.breaker) {
    breaker = {
      statuses: safety.breaker.statuses ?? BREAKER_STATUSES,
      threshold: positive(safety.breaker.threshold ?? 5, 'breaker.threshold'),
      windowMs: durationToMs(safety.breaker.windowDuration ?? 'PT1M'),
    };
    if (breaker.windowMs === undefined) {
      fail(`upstream ${name}: invalid safety.breaker.windowDuration`);
    }
  }
  const requireUserAgent = safety.requireUserAgent ?? true;
  if (requireUserAgent && !headers['user-agent']) {
    fail(`upstream ${name}: safety limits require a user-agent header that identifies the benchmark`);
  }
  return {
    rate,
    concurrency: positive(safety.concurrency, 'concurrency'),
    budget: positive(safety.budget, 'budget'),
    maxWaitMs: positive(safety.maxWaitMs ?? 60_000, 'maxWaitMs'),
    breaker,
    requireUserAgent,
  };
}

function normalizeRecording(recording, fail) {
  const mode = recording?.mode ?? 'off';
  if (![ 'off', 'record', 'replay' ].includes(mode)) {
    fail('recording.mode must be off, record or replay');
  }
  if (mode !== 'off' && !recording.dir) {
    fail('recording needs a dir');
  }
  return { mode, dir: recording?.dir, maxBytes: recording?.maxBytes ?? 64 * 1024 * 1024 };
}

/**
 * Normalize a URL for comparison: lowercase scheme and host, default ports dropped.
 * Paths are kept as they are, but a trailing slash is ignored, as endpoints are commonly referred to both ways.
 * @param {string} url
 */
export function normalizeEndpointUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  const href = parsed.href;
  return href.endsWith('/') && parsed.pathname !== '/' ? href.slice(0, -1) : href;
}

/**
 * Find the member that stands for an endpoint URL: its upstream URL or one of its aliases.
 * @param {object} config A normalized configuration.
 * @param {string} url
 * @returns {object | undefined} The member.
 */
export function memberForUrl(config, url) {
  const target = normalizeEndpointUrl(url);
  const matches = Object.values(config.members).filter(member =>
    [ member.upstream.url, ...member.aliases ].some(candidate => normalizeEndpointUrl(candidate) === target));
  if (matches.length > 1) {
    throw new Error(`${url} matches several endpoints: ${matches.map(member => member.name).join(', ')}`);
  }
  return matches[0];
}
