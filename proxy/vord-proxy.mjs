#!/usr/bin/env node
/**
 * vord-proxy: a client-side SPARQL proxy that emulates restricted endpoints in front of any SPARQL endpoint.
 *
 * Every federation member listens on its own port, so that clients that keep per-host state (such as Comunica's
 * HTTP actors) see separate hosts. The restriction profile, and optionally the description mode, are chosen in the path:
 *   http://localhost:<port>/<profile>/sparql             restrictions advertised in the service description
 *   http://localhost:<port>/<profile>/provided/sparql    not advertised; served as a VoRD file on the admin port
 *   http://localhost:<port>/<profile>/none/sparql        not described at all, only enforced
 * Requests without a query obtain the service description.
 *
 * A query passes through three layers:
 * 1. emulation: the profile's hard restrictions (rate 429 or queue, concurrency 503 or queue, evaluation time 503,
 *    result size by truncation or 413). A request rejected here never reaches the upstream.
 * 2. safety: limits per upstream host that protect real endpoints (rate, concurrency, budget, breaker, kill switch).
 * 3. upstream: the request to the upstream (GET or POST, configured headers, default graph, timeout parameter),
 *    streamed back through a scanner that counts and truncates results; or a recorded response (replay).
 * Every request is logged with its run (from a request header, or else the run set on the admin port),
 * the emulated and upstream outcomes, bytes, rows, waits and violations of the upstream's published policy.
 */
import { once } from 'node:events';
import { createWriteStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DESCRIPTION_MODES, normalizeConfig } from './lib/config.mjs';
import { ConcurrencyGate, SlidingWindows } from './lib/limiter.mjs';
import { PolicyMonitor } from './lib/policy.mjs';
import { loadProfiles, normalizeRestriction, restrictionsFor, serviceDescription } from './lib/profiles.mjs';
import { Recorder } from './lib/recorder.mjs';
import { SafetyLayer } from './lib/safety.mjs';
import { createScanner, scanAll } from './lib/scanner.mjs';
import { getQueryForm } from './lib/sparql.mjs';
import { acceptFor, buildUpstreamRequest } from './lib/upstream.mjs';

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
 * Parse the path of an endpoint request: /<profile>/sparql or /<profile>/<mode>/sparql.
 * @param {string} pathname
 * @returns {{ profileId: string, mode: string } | undefined}
 */
export function parseEndpointPath(pathname) {
  const parts = pathname.split('/').slice(1);
  if (parts.length === 2 && parts[1] === 'sparql') {
    return { profileId: parts[0], mode: 'advertised' };
  }
  if (parts.length === 3 && parts[2] === 'sparql' && DESCRIPTION_MODES.includes(parts[1])) {
    return { profileId: parts[0], mode: parts[1] };
  }
  return undefined;
}

/**
 * Whether a profile describes restrictions for a member, which are advertised or served as a VoRD file.
 * @param {object} profile
 * @param {string} memberName
 */
export function describesRestrictions(profile, memberName) {
  return profile.advertise !== false && restrictionsFor(profile, memberName).length > 0;
}

export const emptyStats = () => ({
  requests: 0,
  serviceDescriptions: 0,
  truncated: 0,
  byStatus: {},
  byReason: {},
  upstreamRequests: 0,
  replayed: 0,
  safety: 0,
  policyViolations: 0,
  bytesOut: 0,
});

/**
 * Create the request handlers of the proxy.
 * @param {object} options
 * @param {object} options.config A normalized proxy configuration (lib/config.mjs).
 * @param {Map<string, object>} options.profiles
 * @param {(entry: object) => void} [options.log]
 * @param {() => number} [options.clock]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createProxy({ config, profiles, log = () => {}, clock = Date.now, fetchImpl = fetch }) {
  const states = new Map();
  const stats = new Map();
  const safety = new SafetyLayer(config.upstreams.values(), { clock });
  const policy = new PolicyMonitor({ clock });
  const recorder = new Recorder(config.recording);
  let run;

  function getState(memberName, profile, client) {
    const key = `${memberName}|${profile.id}|${client}`;
    let state = states.get(key);
    if (!state) {
      const plan = enforcementPlan(restrictionsFor(profile, memberName));
      state = {
        plan,
        windows: SlidingWindows.fromRestrictions(plan.rates),
        gate: plan.concurrency ? new ConcurrencyGate(plan.concurrency.maxValue) : undefined,
      };
      states.set(key, state);
    }
    return state;
  }

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
      if (entry.reason?.startsWith('safety-')) {
        runStats.safety++;
      }
      if (entry.policy?.length > 0) {
        runStats.policyViolations++;
      }
    }
    if (entry.upstream?.source === 'live') {
      runStats.upstreamRequests++;
    }
    if (entry.upstream?.source === 'replay') {
      runStats.replayed++;
    }
    runStats.bytesOut += entry.bytesOut ?? 0;
    log(entry);
  }

  async function handleEndpoint(memberName, req, res) {
    const start = clock();
    const member = config.members[memberName];
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = parseEndpointPath(url.pathname);
    const profile = path && profiles.get(path.profileId);
    if (!profile) {
      return send(res, 404, { 'content-type': 'text/plain' }, 'Unknown endpoint path. Use /<profile>/sparql or ' +
        `/<profile>/<${DESCRIPTION_MODES.join('|')}>/sparql with one of: ${[ ...profiles.keys() ].join(', ')}\n`);
    }
    // The client going away stops waiting and aborts the upstream request.
    const clientGone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone.abort(new Error('The client closed the connection'));
      }
    });
    const entry = {
      ts: new Date(start).toISOString(),
      run: req.headers[config.runHeader] ?? run,
      endpoint: memberName,
      profile: profile.id,
      description: path.mode,
      client: req.socket.remoteAddress,
    };
    // Set for queries: the check against the upstream's published policy.
    let politeness;
    let queuedMs = 0;
    const finish = (status, fields) => {
      const violations = politeness ? [ ...politeness.violations, ...politeness.done(entry.upstreamMs) ] : undefined;
      record({ ...entry, status, ms: clock() - start, queuedMs: politeness ? queuedMs : undefined, ...fields,
        policy: violations?.length > 0 ? violations : undefined });
    };

    let query;
    let bytesIn;
    try {
      ({ query, bytesIn } = await readQuery(req, url));
    } catch (error) {
      send(res, 400, { 'content-type': 'text/plain' }, `${error.message}\n`);
      return finish(400, { kind: 'query', reason: 'bad-request' });
    }
    if (!query) {
      return serveServiceDescription(`http://${req.headers.host}${url.pathname}`);
    }

    const form = getQueryForm(query);
    Object.assign(entry, { kind: 'query', form, bytesIn, query: query.slice(0, 2_000) });
    const { plan, windows, gate } = getState(memberName, profile, entry.client);
    politeness = policy.arrive(member.upstream);
    const reject = (status, reason, retryAfterMs, fields) => {
      const headers = { 'content-type': 'text/plain' };
      if (retryAfterMs !== undefined) {
        headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
      }
      const body = `Request rejected by vord-proxy: ${reason}\n`;
      send(res, status, headers, body);
      finish(status, { reason, retryAfter: headers['retry-after'], bytesOut: Buffer.byteLength(body), ...fields });
    };

    let holdsSlot = false;
    try {
      // 1. Emulation: rate and quota restrictions
      if (windows) {
        let wait;
        while ((wait = windows.waitTime(clock())) > 0) {
          if (!plan.rateQueue) {
            return reject(plan.rateStatus, 'rate', wait);
          }
          await sleep(wait, undefined, { signal: clientGone.signal });
          queuedMs += wait;
        }
      }
      // Concurrency restrictions
      if (gate) {
        if (!gate.tryAcquire()) {
          if (plan.concurrency.enforcement !== 'QueueRequest') {
            return reject(plan.concurrency.statusCode ?? 503, 'concurrency', 1_000);
          }
          const queueStart = clock();
          await gate.acquire(clientGone.signal);
          queuedMs += clock() - queueStart;
        }
        holdsSlot = true;
      }
      windows?.record(clock());
      if (config.latencyMs > 0) {
        await sleep(config.latencyMs, undefined, { signal: clientGone.signal });
      }

      const accept = acceptFor(member.upstream, form);
      const recorded = await recorder.lookup(memberName, query, accept);
      if (recorded) {
        return await replay(recorded);
      }

      // 2. Safety
      const admission = await safety.admit(member.upstream, clientGone.signal);
      if (!admission.ok) {
        const body = `Request refused by the safety layer of vord-proxy: ${admission.reason}\n`;
        send(res, 503, { 'content-type': 'text/plain', 'x-vord-proxy-safety': admission.reason }, body);
        return finish(503, { reason: `safety-${admission.reason}`, safetyWaitMs: admission.waitMs, bytesOut: Buffer.byteLength(body) });
      }
      // 3. Upstream
      try {
        return await forward(admission, accept);
      } finally {
        admission.release();
      }
    } catch (error) {
      if (clientGone.signal.aborted) {
        return finish(499, { reason: 'client-aborted' });
      }
      throw error;
    } finally {
      if (holdsSlot) {
        gate.release();
      }
      // Ends the request for the policy check, if finish was not called.
      politeness.done();
    }

    async function serveServiceDescription(endpointUrl) {
      if (path.mode === 'advertised' || member.upstream.serviceDescription !== 'passthrough') {
        const described = path.mode === 'advertised' ? profile : { ...profile, advertise: false };
        const body = serviceDescription(endpointUrl, described, memberName);
        send(res, 200, { 'content-type': 'text/turtle' }, body);
        return finish(200, { kind: 'sd', bytesOut: Buffer.byteLength(body) });
      }
      // The upstream's own service description, as a client would see it without the proxy.
      const admission = await safety.admit(member.upstream, clientGone.signal);
      if (!admission.ok) {
        send(res, 503, { 'content-type': 'text/plain', 'x-vord-proxy-safety': admission.reason }, '');
        return finish(503, { kind: 'sd', reason: `safety-${admission.reason}` });
      }
      try {
        const response = await fetchImpl(member.upstream.url, {
          headers: { ...member.upstream.headers, accept: 'text/turtle, application/rdf+xml;q=0.9, */*;q=0.1' },
          signal: AbortSignal.any([ clientGone.signal, admission.signal ]),
        });
        safety.report(member.upstream, response.status);
        const body = Buffer.from(await response.arrayBuffer());
        send(res, response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain' }, body);
        return finish(response.status, { kind: 'sd', bytesOut: body.length, upstream: { source: 'live', status: response.status, bytes: body.length }});
      } catch (error) {
        safety.report(member.upstream, 'error');
        send(res, 502, { 'content-type': 'text/plain' }, `Upstream error: ${error.message}\n`);
        return finish(502, { kind: 'sd', reason: 'upstream', upstream: { source: 'live', error: error.message }});
      } finally {
        admission.release();
      }
    }

    async function replay(entryRecorded) {
      const upstreamInfo = {
        source: 'replay',
        status: entryRecorded.status,
        ms: entryRecorded.upstreamMs,
        bytes: Buffer.byteLength(entryRecorded.body),
      };
      if (plan.timeoutMs !== undefined && entryRecorded.upstreamMs > plan.timeoutMs) {
        await sleep(plan.timeoutMs, undefined, { signal: clientGone.signal });
        return reject(plan.timeoutStatus, 'timeout', undefined, { upstream: upstreamInfo });
      }
      await sleep(entryRecorded.upstreamMs, undefined, { signal: clientGone.signal });
      entry.upstreamMs = entryRecorded.upstreamMs;
      if (entryRecorded.status < 200 || entryRecorded.status >= 300) {
        send(res, entryRecorded.status, { 'content-type': entryRecorded.contentType }, entryRecorded.body);
        return finish(entryRecorded.status, { reason: 'upstream', upstream: upstreamInfo, bytesOut: upstreamInfo.bytes });
      }
      const limit = plan.resultReject ? undefined : plan.resultLimit;
      const result = scanAll(entryRecorded.body, entryRecorded.contentType, limit);
      if (plan.resultReject && result.rows > plan.resultLimit) {
        return reject(plan.resultStatus, 'result-size', undefined, { upstream: upstreamInfo, rows: result.rows });
      }
      const headers = { 'content-type': entryRecorded.contentType };
      if (result.truncated) {
        headers['x-sparql-maxrows'] = String(limit);
      }
      const body = Buffer.from(result.body);
      send(res, 200, headers, body);
      return finish(200, { rows: result.rows, truncated: result.truncated, upstream: upstreamInfo, bytesOut: body.length });
    }

    async function forward(admission, accept) {
      const timeoutSignal = plan.timeoutMs === undefined ? undefined : AbortSignal.timeout(plan.timeoutMs);
      const signal = AbortSignal.any([ clientGone.signal, admission.signal, ...timeoutSignal ? [ timeoutSignal ] : [] ]);
      const request = buildUpstreamRequest(member.upstream, {
        query,
        form,
        defaultGraph: member.defaultGraph,
        timeoutMs: plan.timeoutMs,
      });
      const upstreamStart = clock();
      const upstreamInfo = { source: 'live', bytes: 0 };
      const fields = () => ({ safetyWaitMs: admission.waitMs, upstream: upstreamInfo });
      const stopTiming = () => {
        upstreamInfo.ms ??= clock() - upstreamStart;
        entry.upstreamMs = upstreamInfo.ms;
      };
      const failed = error => {
        stopTiming();
        if (timeoutSignal?.aborted) {
          if (res.headersSent) {
            res.destroy();
          }
          return reject(plan.timeoutStatus, 'timeout', undefined, fields());
        }
        if (clientGone.signal.aborted) {
          throw error;
        }
        const killed = admission.signal.aborted;
        if (!killed) {
          safety.report(member.upstream, 'error');
        }
        upstreamInfo.error = killed ? 'stopped by the kill switch' : error.message;
        const body = `Upstream error: ${upstreamInfo.error}\n`;
        if (res.headersSent) {
          // The response was streaming already: the client sees an incomplete response.
          res.destroy();
          return finish(res.statusCode, { reason: killed ? 'safety-killed' : 'upstream', streamAborted: true, ...fields() });
        }
        const status = killed ? 503 : 502;
        send(res, status, { 'content-type': 'text/plain' }, body);
        return finish(status, { reason: killed ? 'safety-killed' : 'upstream', bytesOut: Buffer.byteLength(body), ...fields() });
      };

      let upstream;
      try {
        upstream = await fetchImpl(request.url, { ...request.init, signal });
      } catch (error) {
        return failed(error);
      }
      upstreamInfo.status = upstream.status;
      safety.report(member.upstream, upstream.status);
      const contentType = upstream.headers.get('content-type') ?? 'text/plain';

      if (!upstream.ok) {
        let body;
        try {
          body = Buffer.from(await upstream.arrayBuffer());
        } catch (error) {
          return failed(error);
        }
        stopTiming();
        upstreamInfo.bytes = body.length;
        await recorder.store(memberName, query, accept, { status: upstream.status, contentType, body, upstreamMs: upstreamInfo.ms });
        send(res, upstream.status, { 'content-type': contentType }, body);
        return finish(upstream.status, { reason: 'upstream', bytesOut: body.length, ...fields() });
      }

      // The response streams through, unless its outcome can still change:
      // - with a result limit, it is held back until the limit decides whether it is truncated (at most `limit` results);
      // - with a timeout or a rejecting result limit, or when recording, it is held back until it is complete.
      const limit = plan.resultReject ? undefined : plan.resultLimit;
      const streaming = limit === undefined && plan.timeoutMs === undefined && !plan.resultReject && !recorder.recording;
      const scanner = createScanner(contentType, limit);
      const decoder = new TextDecoder();
      const held = [];
      let raw = recorder.recording ? [] : undefined;
      let bytesOut = 0;
      const write = async text => {
        if (!text) {
          return;
        }
        if (!streaming) {
          held.push(text);
          return;
        }
        const chunk = Buffer.from(text);
        bytesOut += chunk.length;
        if (!res.write(chunk)) {
          await once(res, 'drain', { signal });
        }
      };
      const overLimit = () => plan.resultReject && scanner.rows > plan.resultLimit;
      try {
        if (streaming) {
          res.writeHead(200, { 'content-type': contentType });
        }
        for await (const chunk of upstream.body ?? []) {
          upstreamInfo.bytes += chunk.length;
          if (raw) {
            raw.push(chunk);
            if (upstreamInfo.bytes > recorder.maxBytes) {
              // Too large to record; it is not read further than needed.
              raw = undefined;
              recorder.counts.skipped++;
            }
          }
          if (!scanner.done) {
            await write(scanner.push(decoder.decode(chunk, { stream: true })));
          }
          // Stop reading once the outcome is decided, unless the whole response is recorded.
          if ((overLimit() || scanner.done) && !raw) {
            break;
          }
        }
        if (!scanner.done && !overLimit()) {
          await write(scanner.push(decoder.decode()));
          await write(scanner.end());
        }
      } catch (error) {
        return failed(error);
      }
      stopTiming();
      if (scanner.done || overLimit()) {
        // The rest of the upstream response is not read.
        upstreamInfo.stoppedEarly = !raw || undefined;
      }
      if (raw) {
        await recorder.store(memberName, query, accept, {
          status: upstream.status, contentType, body: Buffer.concat(raw), upstreamMs: upstreamInfo.ms,
        });
      }
      if (overLimit()) {
        return reject(plan.resultStatus, 'result-size', undefined, { rows: scanner.rows, ...fields() });
      }
      if (streaming) {
        res.end();
      } else {
        const headers = { 'content-type': contentType };
        if (scanner.truncated) {
          headers['x-sparql-maxrows'] = String(limit);
        }
        const body = Buffer.from(held.join(''));
        bytesOut = body.length;
        send(res, 200, headers, body);
      }
      return finish(200, { rows: scanner.rows, truncated: scanner.truncated, bytesOut, ...fields() });
    }
  }

  async function handleAdmin(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (status, value) => send(res, status, { 'content-type': 'application/json' }, JSON.stringify(value));
    if (req.method === 'POST' && url.pathname === '/reset') {
      states.clear();
      policy.reset();
      run = url.searchParams.get('run') ?? undefined;
      // A run starts with fresh statistics, also if an earlier benchmark used the same run ID.
      stats.delete(run ?? '');
      return json(200, { ok: true, run });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      return json(200, stats.get(url.searchParams.get('run') ?? '') ?? emptyStats());
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(200, {
        ok: true,
        run,
        endpoints: Object.fromEntries(Object.values(config.members).map(member => [ member.name, member.port ])),
        profiles: [ ...profiles.keys() ],
        descriptionModes: DESCRIPTION_MODES,
        safety: safety.status(),
        recording: recorder.status(),
      });
    }
    const vord = /^\/vord\/([\w-]+)\/([\w-]+)\.ttl$/u.exec(url.pathname);
    if (req.method === 'GET' && vord) {
      const [ , profileId, memberName ] = vord;
      const profile = profiles.get(profileId);
      const member = config.members[memberName];
      if (!profile || !member || !describesRestrictions(profile, memberName)) {
        return send(res, 404, { 'content-type': 'text/plain' }, `No restrictions to describe for ${memberName} under ${profileId}\n`);
      }
      // The same description as the advertised one, for the endpoint URL of the provided mode.
      const endpointUrl = `${config.publicBaseUrl}:${member.port}/${profileId}/provided/sparql`;
      return send(res, 200, { 'content-type': 'text/turtle' }, serviceDescription(endpointUrl, profile, memberName));
    }
    if (req.method === 'GET' && url.pathname === '/safety') {
      return json(200, safety.status());
    }
    if (req.method === 'POST' && url.pathname === '/safety/kill') {
      safety.kill();
      return json(200, safety.status());
    }
    if (req.method === 'POST' && url.pathname === '/safety/resume') {
      safety.resume();
      return json(200, safety.status());
    }
    if (req.method === 'POST' && url.pathname === '/safety/close') {
      return json(200, { closed: safety.close(url.searchParams.get('host') ?? undefined), ...safety.status() });
    }
    send(res, 404, { 'content-type': 'text/plain' }, [
      'Use POST /reset?run=<id>, GET /stats?run=<id>, GET /health, GET /vord/<profile>/<endpoint>.ttl,',
      'GET /safety, POST /safety/kill, POST /safety/resume or POST /safety/close[?host=<host>]',
      '',
    ].join('\n'));
  }

  return { handleEndpoint, handleAdmin, getRunStats, states, safety, policy, recorder };
}

async function readQuery(req, url) {
  if (req.method === 'GET') {
    return { query: url.searchParams.get('query') ?? undefined, bytesIn: 0 };
  }
  if (req.method !== 'POST') {
    throw new Error(`Unsupported method ${req.method}`);
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const body = raw.toString('utf8');
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/sparql-query')) {
    return { query: body, bytesIn: raw.length };
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { query: new URLSearchParams(body).get('query') ?? undefined, bytesIn: raw.length };
  }
  throw new Error(`Unsupported content type ${contentType}`);
}

function send(res, status, headers, body) {
  if (res.headersSent || res.destroyed) {
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Start the proxy servers.
 * @param {object} options
 * @param {object} options.config A proxy configuration, as in a suite's endpoints file; normalized here.
 * @param {Map<string, object>} options.profiles
 * @param {string} [options.logPath] A JSON-lines request log.
 * @param {(entry: object) => void} [options.log] Receives every log entry (if there is no logPath).
 * @param {string} [options.host]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function startProxy({ config: rawConfig, profiles, logPath, log, host = '0.0.0.0', fetchImpl }) {
  const config = normalizeConfig(rawConfig);
  const logStream = logPath ? createWriteStream(logPath, { flags: 'a' }) : undefined;
  const proxy = createProxy({
    config,
    profiles,
    log: logStream ? entry => logStream.write(`${JSON.stringify(entry)}\n`) : log,
    fetchImpl,
  });
  const servers = [];
  const listen = (port, handler) => new Promise((resolveListen, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch(error => {
        if (res.headersSent) {
          res.destroy();
        } else {
          send(res, 500, { 'content-type': 'text/plain' }, `${error.stack}\n`);
        }
      });
    });
    // Comunica keeps connections alive; avoid long-running benchmarks accumulating idle sockets.
    server.keepAliveTimeout = 5_000;
    server.once('error', reject);
    server.listen(port, host, () => resolveListen(server));
  });
  const members = Object.values(config.members);
  for (const member of members) {
    servers.push(await listen(member.port, (req, res) => proxy.handleEndpoint(member.name, req, res)));
  }
  servers.push(await listen(config.adminPort, proxy.handleAdmin));
  const names = [ ...members.map(member => member.name), 'admin' ];
  return {
    proxy,
    config,
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
      config: { type: 'string', default: 'suites/watdiv/endpoints.json' },
      profiles: { type: 'string', default: 'profiles' },
      log: { type: 'string' },
      record: { type: 'string' },
      replay: { type: 'string' },
    },
  });
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  if (values.record || values.replay) {
    config.recording = { ...config.recording, mode: values.record ? 'record' : 'replay', dir: values.record ?? values.replay };
  }
  const profiles = loadProfiles(resolve(values.profiles));
  const { ports } = await startProxy({ config, profiles, logPath: values.log });
  process.stdout.write(`vord-proxy: ${Object.entries(ports).map(([ name, port ]) => `${name}:${port}`).join(', ')}; ` +
    `profiles: ${[ ...profiles.keys() ].join(', ')}\n`);
  for (const signal of [ 'SIGINT', 'SIGTERM' ]) {
    process.on(signal, () => process.exit(0));
  }
}
