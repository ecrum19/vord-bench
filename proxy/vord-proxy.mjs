#!/usr/bin/env node
/**
 * vord-proxy: a SPARQL proxy that describes and enforces VoRD restrictions in front of a SPARQL store.
 *
 * Every endpoint listens on its own port, so that clients that keep per-host state (such as Comunica's
 * HTTP actors) see separate hosts. The restriction profile is chosen by the first path segment:
 *   http://localhost:<port>/<profile>/sparql
 * Requests without a query obtain the service description, including the profile's VoRD restrictions.
 * An admin server resets the limiter state and tags the request log per benchmark run.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ConcurrencyGate, SlidingWindows } from './lib/limiter.mjs';
import { loadProfiles, normalizeRestriction, restrictionsFor, serviceDescription } from './lib/profiles.mjs';
import { getQueryForm, truncateResults, upstreamAccept } from './lib/sparql.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Determine how the hard restrictions of an endpoint are enforced.
 * Soft restrictions (hardRestriction false) are only advertised.
 * @param {object[]} restrictions Restriction descriptions from a profile.
 */
export function enforcementPlan(restrictions) {
  const hard = restrictions.map(normalizeRestriction).filter(restriction => restriction.hard);
  const rates = hard.filter(restriction => [ 'RateRestriction', 'QuotaRestriction' ].includes(restriction.type));
  const concurrency = hard.filter(restriction => restriction.type === 'ConcurrentRequestsRestriction' &&
    restriction.maxValue > 0);
  const responseTime = hard.filter(restriction => restriction.type === 'ResponseTimeRestriction' &&
    restriction.enforcement === 'RejectRequest' && restriction.maxValue > 0);
  const resultSize = hard.filter(restriction => restriction.type === 'ResultSizeRestriction' &&
    restriction.maxValue >= 0);
  const minBy = (list, key) => list.length > 0 ? list.reduce((a, b) => b[key] < a[key] ? b : a) : undefined;
  const concurrencyRestriction = minBy(concurrency, 'maxValue');
  const responseTimeRestriction = minBy(responseTime, 'maxValue');
  const resultSizeRestriction = minBy(resultSize, 'maxValue');
  return {
    rates,
    rateQueue: rates.length > 0 && rates.every(restriction => restriction.enforcement === 'QueueRequest'),
    rateStatus: rates.find(restriction => restriction.statusCode)?.statusCode ?? 429,
    concurrency: concurrencyRestriction,
    timeoutMs: responseTimeRestriction ? responseTimeRestriction.maxValue * 1_000 : undefined,
    timeoutStatus: responseTimeRestriction?.statusCode ?? 503,
    resultLimit: resultSizeRestriction?.maxValue,
    resultReject: resultSizeRestriction?.enforcement === 'RejectRequest',
    resultStatus: resultSizeRestriction?.statusCode ?? 413,
  };
}

/**
 * Create the request handlers of the proxy.
 * @param {object} options
 * @param {Record<string, { port: number, upstream: string }>} options.endpoints
 * @param {Map<string, object>} options.profiles
 * @param {number} [options.latencyMs] An artificial delay added before every upstream request.
 * @param {(entry: object) => void} [options.log]
 * @param {() => number} [options.clock]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createProxy({ endpoints, profiles, latencyMs = 0, log = () => {}, clock = Date.now, fetchImpl = fetch }) {
  const states = new Map();
  const stats = new Map();
  let run;

  function getState(endpointName, profile, client) {
    const key = `${endpointName}|${profile.id}|${client}`;
    let state = states.get(key);
    if (!state) {
      const plan = enforcementPlan(restrictionsFor(profile, endpointName));
      state = {
        plan,
        windows: SlidingWindows.fromRestrictions(plan.rates),
        gate: plan.concurrency ? new ConcurrencyGate(plan.concurrency.maxValue) : undefined,
      };
      states.set(key, state);
    }
    return state;
  }

  function record(entry) {
    const runStats = getRunStats(entry.run);
    if (entry.kind === 'sd') {
      runStats.serviceDescriptions++;
    } else {
      runStats.requests++;
      runStats.byStatus[entry.status] = (runStats.byStatus[entry.status] ?? 0) + 1;
      if (entry.truncated) {
        runStats.truncated++;
      }
      if (entry.reason) {
        runStats.byReason[entry.reason] = (runStats.byReason[entry.reason] ?? 0) + 1;
      }
    }
    log(entry);
  }

  const emptyStats = () => ({ requests: 0, serviceDescriptions: 0, truncated: 0, byStatus: {}, byReason: {}});

  function getRunStats(runId = '') {
    let runStats = stats.get(runId);
    if (!runStats) {
      runStats = emptyStats();
      stats.set(runId, runStats);
      // Keep the memory use bounded for long benchmarks.
      if (stats.size > 10_000) {
        stats.delete(stats.keys().next().value);
      }
    }
    return runStats;
  }

  async function handleEndpoint(endpointName, req, res) {
    const start = clock();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const [ , profileId, tail, ...rest ] = url.pathname.split('/');
    const profile = profiles.get(profileId);
    if (!profile || tail !== 'sparql' || rest.length > 0) {
      return send(res, 404, { 'content-type': 'text/plain' },
        `Unknown endpoint path. Use /<profile>/sparql with one of: ${[ ...profiles.keys() ].join(', ')}\n`);
    }
    const entry = {
      ts: new Date(start).toISOString(),
      run,
      endpoint: endpointName,
      profile: profile.id,
      client: req.socket.remoteAddress,
    };

    let query;
    try {
      query = await readQuery(req, url);
    } catch (error) {
      send(res, 400, { 'content-type': 'text/plain' }, `${error.message}\n`);
      return record({ ...entry, kind: 'query', status: 400, ms: clock() - start, reason: 'bad-request' });
    }

    if (!query) {
      const endpointUrl = `http://${req.headers.host}/${profile.id}/sparql`;
      send(res, 200, { 'content-type': 'text/turtle' }, serviceDescription(endpointUrl, profile, endpointName));
      return record({ ...entry, kind: 'sd', status: 200, ms: clock() - start });
    }

    const form = getQueryForm(query);
    Object.assign(entry, { kind: 'query', form, queryBytes: Buffer.byteLength(query), query: query.slice(0, 2_000) });
    const { plan, windows, gate } = getState(endpointName, profile, entry.client);
    const reject = (status, reason, retryAfterMs) => {
      const headers = { 'content-type': 'text/plain' };
      if (retryAfterMs !== undefined) {
        headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
      }
      send(res, status, headers, `Request rejected by vord-proxy: ${reason}\n`);
      record({ ...entry, status, ms: clock() - start, reason, retryAfter: headers['retry-after'] });
    };

    // Rate and quota restrictions
    if (windows) {
      let wait;
      while ((wait = windows.waitTime(clock())) > 0) {
        if (!plan.rateQueue) {
          return reject(plan.rateStatus, 'rate', wait);
        }
        await sleep(wait);
      }
    }

    // Concurrency restrictions
    let holdsSlot = false;
    if (gate) {
      if (!gate.tryAcquire()) {
        if (plan.concurrency.enforcement !== 'QueueRequest') {
          return reject(plan.concurrency.statusCode ?? 503, 'concurrency', 1_000);
        }
        await gate.acquire();
      }
      holdsSlot = true;
    }
    windows?.record(clock());

    try {
      if (latencyMs > 0) {
        await sleep(latencyMs);
      }
      let upstream;
      let body;
      try {
        upstream = await fetchImpl(endpoints[endpointName].upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: upstreamAccept(form) },
          body: new URLSearchParams({ query }).toString(),
          signal: plan.timeoutMs ? AbortSignal.timeout(plan.timeoutMs) : undefined,
        });
        body = await upstream.text();
      } catch (error) {
        if (error.name === 'TimeoutError') {
          return reject(plan.timeoutStatus, 'timeout');
        }
        send(res, 502, { 'content-type': 'text/plain' }, `Upstream error: ${error.message}\n`);
        return record({ ...entry, status: 502, ms: clock() - start, reason: 'upstream' });
      }

      const contentType = upstream.headers.get('content-type') ?? 'text/plain';
      if (!upstream.ok) {
        send(res, upstream.status, { 'content-type': contentType }, body);
        return record({ ...entry, status: upstream.status, ms: clock() - start, reason: 'upstream' });
      }

      const limit = plan.resultReject ? undefined : plan.resultLimit;
      const result = truncateResults(body, contentType, limit);
      if (plan.resultReject && result.rows > plan.resultLimit) {
        return reject(plan.resultStatus, 'result-size');
      }
      const headers = { 'content-type': contentType };
      if (result.truncated) {
        headers['x-sparql-maxrows'] = String(limit);
      }
      send(res, 200, headers, result.body);
      record({ ...entry, status: 200, ms: clock() - start, rows: result.rows, truncated: result.truncated });
    } finally {
      if (holdsSlot) {
        gate.release();
      }
    }
  }

  async function handleAdmin(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST' && url.pathname === '/reset') {
      states.clear();
      run = url.searchParams.get('run') ?? undefined;
      // A run starts with fresh statistics, also if an earlier benchmark used the same run ID.
      stats.delete(run ?? '');
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, run }));
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const runStats = stats.get(url.searchParams.get('run') ?? '') ?? emptyStats();
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(runStats));
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
        ok: true,
        run,
        endpoints: Object.fromEntries(Object.entries(endpoints).map(([ name, { port }]) => [ name, port ])),
        profiles: [ ...profiles.keys() ],
      }));
    }
    send(res, 404, { 'content-type': 'text/plain' }, 'Use POST /reset?run=<id>, GET /stats?run=<id> or GET /health\n');
  }

  return { handleEndpoint, handleAdmin, getRunStats, states };
}

async function readQuery(req, url) {
  if (req.method === 'GET') {
    return url.searchParams.get('query') ?? undefined;
  }
  if (req.method !== 'POST') {
    throw new Error(`Unsupported method ${req.method}`);
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/sparql-query')) {
    return body;
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body).get('query') ?? undefined;
  }
  throw new Error(`Unsupported content type ${contentType}`);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Start the proxy servers.
 * @param {object} options
 * @param {{ adminPort: number, latencyMs?: number, endpoints: Record<string, { port: number, upstream: string }> }} options.config
 * @param {Map<string, object>} options.profiles
 * @param {string} [options.logPath] A JSON-lines request log.
 * @param {string} [options.host]
 */
export async function startProxy({ config, profiles, logPath, host = '0.0.0.0', fetchImpl }) {
  const logStream = logPath ? createWriteStream(logPath, { flags: 'a' }) : undefined;
  const proxy = createProxy({
    endpoints: config.endpoints,
    profiles,
    latencyMs: config.latencyMs ?? 0,
    log: logStream ? entry => logStream.write(`${JSON.stringify(entry)}\n`) : undefined,
    fetchImpl,
  });
  const servers = [];
  const listen = (port, handler) => new Promise((resolveListen, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch(error => {
        if (!res.headersSent) {
          send(res, 500, { 'content-type': 'text/plain' }, `${error.stack}\n`);
        }
      });
    });
    // Comunica keeps connections alive; avoid long-running benchmarks accumulating idle sockets.
    server.keepAliveTimeout = 5_000;
    server.once('error', reject);
    server.listen(port, host, () => resolveListen(server));
  });
  for (const [ name, { port }] of Object.entries(config.endpoints)) {
    servers.push(await listen(port, (req, res) => proxy.handleEndpoint(name, req, res)));
  }
  servers.push(await listen(config.adminPort, proxy.handleAdmin));
  const names = [ ...Object.keys(config.endpoints), 'admin' ];
  return {
    proxy,
    servers,
    ports: Object.fromEntries(names.map((name, i) => [ name, servers[i].address().port ])),
    close: async() => {
      await Promise.all(servers.map(server => new Promise(resolveClose => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      })));
      logStream?.end();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'endpoints.json' },
      profiles: { type: 'string', default: 'profiles' },
      log: { type: 'string' },
    },
  });
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  const profiles = loadProfiles(resolve(values.profiles));
  await startProxy({ config, profiles, logPath: values.log });
  process.stdout.write(`vord-proxy: ${Object.entries(config.endpoints)
    .map(([ name, { port }]) => `${name}:${port}`).join(', ')}; admin:${config.adminPort}; profiles: ${[ ...profiles.keys() ].join(', ')}\n`);
  for (const signal of [ 'SIGINT', 'SIGTERM' ]) {
    process.on(signal, () => process.exit(0));
  }
}
