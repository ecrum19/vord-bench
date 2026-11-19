#!/usr/bin/env node
/**
 * Run a benchmark suite: profiles x scenarios x queries x replications x engines (x description modes).
 * Every run uses a fresh process, after the proxy's limiter state is reset.
 *
 * Usage: node harness/run.mjs [--suite watdiv] [--preset full] [--name <name>] [--dry-run] [--resume]
 *   [--profiles P1-rate,...] [--scenarios single,federated] [--engines A-naive,...] [--descriptions advertised,provided]
 *   [--templates L1,...] [--instances n] [--replications n] [--timeout ms]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_RUN_HEADER, DESCRIPTION_MODES } from '../proxy/lib/config.mjs';
import { loadProfiles, restrictionsFor } from '../proxy/lib/profiles.mjs';
import { ROOT, fromRoot, loadEngineManifest, parseList, readJson } from './lib/config.mjs';
import { groundTruthPath, loadSuite, membersOf, readQueries, scenariosOf } from './lib/suites.mjs';

/**
 * The ID of a run. Runs in the advertised mode keep the IDs of earlier benchmarks.
 */
export function runIdOf({ profile, scenario, queryId, rep, engine, description = 'advertised' }) {
  return `${profile}__${scenario}__${queryId}__r${rep}__${engine}${description === 'advertised' ? '' : `__${description}`}`;
}

/**
 * Build the ordered list of runs.
 * Engines are interleaved per query and rotated per replication, so that drift in the machine's load
 * affects all engines alike. Description modes other than "advertised" only apply to engines that read
 * provided restrictions (the VoRD engines); for the others, the description of restrictions makes no difference.
 * @param {object} selection
 * @param {string[]} [selection.descriptions] Description modes (default: advertised).
 * @param {Set<string>} [selection.vordEngines] Engines that read provided restrictions.
 */
export function buildPlan({ profiles, scenarios, engines, queries, replications, descriptions = [ 'advertised' ], vordEngines = new Set() }) {
  const runs = [];
  for (const profile of profiles) {
    for (const scenario of scenarios) {
      if (profile.scenarios && !profile.scenarios.includes(scenario)) {
        continue;
      }
      for (const query of queries) {
        for (let rep = 0; rep < replications; rep++) {
          const variants = engines.flatMap(engine => (vordEngines.has(engine) ? descriptions : [ 'advertised' ])
            .filter((description, index, all) => all.indexOf(description) === index)
            .map(description => ({ engine, description })));
          for (let i = 0; i < variants.length; i++) {
            const { engine, description } = variants[(i + rep) % variants.length];
            runs.push({
              runId: runIdOf({ profile: profile.id, scenario, queryId: query.id, rep, engine, description }),
              profile: profile.id,
              scenario,
              query,
              rep,
              engine,
              description,
            });
          }
        }
      }
    }
  }
  return runs;
}

/**
 * The URL of an endpoint under a profile and description mode.
 */
export function endpointUrl(config, member, profileId, description = 'advertised') {
  return `${config.proxy.baseUrl}:${config.endpoints[member].port}/${profileId}/` +
    `${description === 'advertised' ? '' : `${description}/`}sparql`;
}

/**
 * The source URLs of a scenario under a profile and description mode.
 */
export function sourcesFor(config, scenario, profileId, description = 'advertised') {
  return membersOf(config, scenario).map(member => endpointUrl(config, member, profileId, description));
}

/**
 * The endpointRestrictions context entry for the provided mode: for every source, the URL of its VoRD file
 * on the proxy's admin port, or an empty list if the profile describes no restrictions for it.
 * @returns {Record<string, string | []> | undefined} Undefined for the other modes.
 */
export function providedRestrictions(config, scenario, profile, description) {
  if (description !== 'provided') {
    return undefined;
  }
  return Object.fromEntries(membersOf(config, scenario).map(member => [
    endpointUrl(config, member, profile.id, description),
    profile.advertise !== false && restrictionsFor(profile, member).length > 0 ?
      `${config.proxy.adminUrl}/vord/${profile.id}/${member}.ttl` :
      [],
  ]));
}

function selection(values, config) {
  const pick = (cli, configured, all, kind) => {
    const chosen = parseList(cli) ?? configured ?? all;
    for (const item of chosen) {
      if (!all.includes(item)) {
        throw new Error(`Unknown ${kind} ${item}; available: ${all.join(', ')}`);
      }
    }
    return chosen;
  };
  const allProfiles = loadProfiles(fromRoot('profiles'));
  const profiles = pick(values.profiles, config.profiles, config.suiteProfiles.filter(id => allProfiles.has(id)), 'profile')
    .map(id => allProfiles.get(id));
  const allScenarios = scenariosOf(config);
  const scenarios = pick(values.scenarios, allScenarios, allScenarios, 'scenario');
  const definitions = readJson('engines/engines.json').engines;
  const engines = pick(values.engines, config.engines, Object.keys(definitions), 'engine');
  const descriptions = pick(values.descriptions, config.descriptions, DESCRIPTION_MODES, 'description mode');
  const vordEngines = new Set(engines.filter(engine => definitions[engine].providedRestrictions));
  const queries = readQueries(config, {
    templates: parseList(values.templates) ?? config.queries.templates,
    instances: values.instances ? Number(values.instances) : config.queries.instances,
  });
  const replications = values.replications ? Number(values.replications) : config.replications;
  return { profiles, scenarios, engines, descriptions, vordEngines, queries, replications };
}

async function proxyHealth(config) {
  try {
    const response = await fetch(`${config.proxy.adminUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

async function dryRun(config, plan, selected, timeoutMs) {
  const byProfile = {};
  for (const run of plan) {
    const key = `${run.profile} / ${run.scenario}${run.description === 'advertised' ? '' : ` / ${run.description}`}`;
    byProfile[key] = (byProfile[key] ?? 0) + 1;
  }
  const out = lines => process.stdout.write(`${lines.join('\n')}\n`);
  const first = plan[0];
  out([
    `Suite: ${config.suite}, preset ${config.preset}${config.description ? ` (${config.description})` : ''}`,
    `Runs: ${plan.length} over ${selected.queries.length} queries x ${selected.replications} replications x ${selected.engines.length} engines`,
    `Engines: ${selected.engines.join(', ')}`,
    `Description modes: ${selected.descriptions.join(', ')} (non-advertised modes for ${[ ...selected.vordEngines ].join(', ') || 'no engines'})`,
    `Queries: ${selected.queries.map(query => query.id).join(', ')}`,
    'Runs per profile / scenario / mode:',
    ...Object.entries(byProfile).map(([ key, count ]) => `  ${key}: ${count}`),
    `Worst case (every run times out after ${timeoutMs / 1_000} s): ${(plan.length * timeoutMs / 3_600_000).toFixed(1)} h`,
    `Example sources (${first?.scenario}): ${first ? sourcesFor(config, first.scenario, first.profile, first.description).join(' ') : '-'}`,
    '',
    'Checks:',
  ]);
  const checks = [];
  try {
    const manifest = loadEngineManifest();
    const missing = selected.engines.filter(engine => !manifest.engines[engine]);
    checks.push([ missing.length === 0, `engines generated from ${manifest.comunicaBranch}@${manifest.comunicaCommit.slice(0, 9)}${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}` ]);
    const leaking = selected.engines.filter(engine => manifest.engines[engine] &&
      Boolean(manifest.engines[engine].providedRestrictions) !== selected.vordEngines.has(engine));
    checks.push([ leaking.length === 0, leaking.length === 0 ?
      'only the VoRD engines read provided restrictions' :
      `provided restrictions do not match the engine definitions for ${leaking.join(', ')} (npm run generate-engines)` ]);
  } catch (error) {
    checks.push([ false, error.message ]);
  }
  const missingTruth = selected.queries.filter(query => !existsSync(groundTruthPath(config, query)));
  checks.push([ missingTruth.length === 0, missingTruth.length === 0 ?
    'ground truth present for all queries' :
    `ground truth missing for ${missingTruth.map(query => query.id).join(', ')} (npm run ground-truth)` ]);
  const health = await proxyHealth(config);
  checks.push([ Boolean(health), health ? `proxy up with profiles ${health.profiles.join(', ')}` : `proxy not reachable at ${config.proxy.adminUrl} (docker compose -f ${config.compose} up -d)` ]);
  if (health) {
    const supportsModes = selected.descriptions.every(mode => health.descriptionModes?.includes(mode));
    checks.push([ supportsModes, supportsModes ? 'proxy supports the description modes' : 'the proxy is too old for the description modes (rebuild it)' ]);
    checks.push([ !health.safety?.tripped, health.safety?.tripped ? 'the safety layer is tripped (GET /safety)' : 'safety layer not tripped' ]);
  }
  checks.push([ existsSync(join(config.comunicaDir, 'node_modules')), `Comunica fork at ${config.comunicaDir}` ]);
  out(checks.map(([ ok, message ]) => `  ${ok ? 'ok  ' : 'FAIL'} ${message}`));
  return checks.every(([ ok ]) => ok);
}

/**
 * Execute one run in a child process.
 * @returns {Promise<object>} The run's measurements.
 */
async function execute(config, manifest, profiles, run, { outDir, timeoutMs, trace }) {
  const engine = manifest.engines[run.engine];
  const endpointRestrictions = providedRestrictions(config, run.scenario, profiles.get(run.profile), run.description);
  if (endpointRestrictions && !engine.providedRestrictions) {
    throw new Error(`Engine ${run.engine} does not read provided restrictions, so it cannot run in the provided mode`);
  }
  const jobsDir = join(outDir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const jobPath = join(jobsDir, `${run.runId}.job.json`);
  const outPath = join(jobsDir, `${run.runId}.out.json`);
  rmSync(outPath, { force: true });
  writeFileSync(jobPath, JSON.stringify({
    runId: run.runId,
    runHeader: DEFAULT_RUN_HEADER,
    comunicaDir: config.comunicaDir,
    compiled: engine.compiled,
    config: engine.config,
    context: { ...engine.context, ...endpointRestrictions ? { endpointRestrictions } : {} },
    sources: sourcesFor(config, run.scenario, run.profile, run.description),
    query: run.query.query,
    groundTruth: groundTruthPath(config, run.query),
    timeoutMs,
    outPath,
    tracePath: trace ? join(outDir, 'traces', `${run.runId}.jsonl`) : undefined,
  }));
  if (trace) {
    mkdirSync(join(outDir, 'traces'), { recursive: true });
  }

  const child = spawn(process.execPath, [
    `--max-old-space-size=${config.maxMemoryMb ?? 4096}`,
    join(ROOT, 'harness/run-query.mjs'),
    jobPath,
  ], {
    cwd: ROOT,
    env: { ...process.env, NODE_PATH: join(config.comunicaDir, 'node_modules') },
    stdio: [ 'ignore', 'ignore', 'pipe' ],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  // The child enforces the query timeout itself; this only catches hanging processes.
  const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 60_000);
  const exitCode = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(killTimer);

  if (existsSync(outPath)) {
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    rmSync(outPath);
    rmSync(jobPath);
    return result;
  }
  return { status: exitCode === null ? 'killed' : 'crashed', error: stderr.trim() || `exit code ${exitCode}` };
}

async function adminRequest(config, method, path) {
  const response = await fetch(`${config.proxy.adminUrl}${path}`, { method });
  if (!response.ok) {
    throw new Error(`Proxy admin request ${path} failed: ${response.status}`);
  }
  return response.json();
}

function describe(result) {
  const statuses = Object.entries(result.requests?.byStatus ?? {})
    .filter(([ status ]) => status !== '200')
    .map(([ status, count ]) => `${count}x${status}`)
    .join(' ');
  return `${result.status} ${result.matched ?? '?'}/${result.expected ?? '?'} results, ` +
    `${((result.timeMs ?? 0) / 1_000).toFixed(1)} s, ${result.requests?.total ?? '?'} requests${statuses ? ` (${statuses})` : ''}` +
    `${result.status !== 'ok' && result.error ? ` - ${result.error.split('\n')[0].slice(0, 160)}` : ''}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'watdiv' },
      preset: { type: 'string' },
      name: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      profiles: { type: 'string' },
      scenarios: { type: 'string' },
      engines: { type: 'string' },
      descriptions: { type: 'string' },
      templates: { type: 'string' },
      instances: { type: 'string' },
      replications: { type: 'string' },
      timeout: { type: 'string' },
      trace: { type: 'boolean' },
    },
  });
  const config = loadSuite(values.suite, values.preset);
  const selected = selection(values, config);
  const plan = buildPlan(selected);
  const timeoutMs = values.timeout ? Number(values.timeout) : config.timeoutMs;

  if (values['dry-run']) {
    const ok = await dryRun(config, plan, selected, timeoutMs);
    process.exit(ok ? 0 : 1);
  }

  const manifest = loadEngineManifest();
  const health = await proxyHealth(config);
  if (!health) {
    throw new Error(`The proxy is not reachable at ${config.proxy.adminUrl}; start it with "docker compose -f ${config.compose} up -d"`);
  }
  if (selected.descriptions.some(mode => !health.descriptionModes?.includes(mode))) {
    throw new Error('The proxy does not support the selected description modes; rebuild and restart it');
  }
  const profiles = new Map(selected.profiles.map(profile => [ profile.id, profile ]));
  const name = values.name ?? new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const outDir = join(ROOT, 'results', name);
  mkdirSync(outDir, { recursive: true });
  const runsPath = join(outDir, 'runs.jsonl');
  const done = new Set();
  if (existsSync(runsPath)) {
    if (!values.resume) {
      throw new Error(`${runsPath} exists; pass --resume to continue it, or choose another --name`);
    }
    for (const line of readFileSync(runsPath, 'utf8').split('\n').filter(Boolean)) {
      done.add(JSON.parse(line).runId);
    }
  }
  writeFileSync(join(outDir, 'setup.json'), `${JSON.stringify({
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    suite: config.suite,
    preset: config.preset,
    config,
    selection: {
      ...selected,
      vordEngines: [ ...selected.vordEngines ],
      profiles: selected.profiles.map(profile => profile.id),
      queries: selected.queries.map(query => query.id),
    },
    timeoutMs,
    comunica: { branch: manifest.comunicaBranch, commit: manifest.comunicaCommit },
  }, null, 2)}\n`);
  const trace = values.trace ?? config.trace ?? false;

  if (config.warmup && done.size === 0) {
    // One unrecorded, unrestricted run per engine, so that the stores' caches are warm before measuring.
    for (const engine of selected.engines) {
      const run = { runId: `warmup__${engine}`, profile: 'P0-none', scenario: selected.scenarios[0], query: selected.queries[0], rep: 0, engine, description: 'advertised' };
      await adminRequest(config, 'POST', `/reset?run=${encodeURIComponent(run.runId)}`);
      const result = await execute(config, manifest, profiles, run, { outDir, timeoutMs, trace: false });
      process.stdout.write(`[warm-up] ${engine} ${run.scenario} ${run.query.id}: ${describe(result)}\n`);
    }
  }

  let index = 0;
  for (const run of plan) {
    index++;
    if (done.has(run.runId)) {
      continue;
    }
    await adminRequest(config, 'POST', `/reset?run=${encodeURIComponent(run.runId)}`);
    const startedAt = new Date().toISOString();
    const result = await execute(config, manifest, profiles, run, { outDir, timeoutMs, trace });
    const server = await adminRequest(config, 'GET', `/stats?run=${encodeURIComponent(run.runId)}`);
    const record = {
      runId: run.runId,
      profile: run.profile,
      scenario: run.scenario,
      engine: run.engine,
      description: run.description,
      query: run.query.id,
      template: run.query.template,
      rep: run.rep,
      startedAt,
      ...result,
      server,
    };
    appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
    process.stdout.write(`[${index}/${plan.length}] ${run.profile} ${run.scenario} ${run.query.id} r${run.rep} ${run.engine}` +
      `${run.description === 'advertised' ? '' : ` (${run.description})`}: ${describe(result)}\n`);
    // The safety layer pauses the campaign: a breaker opened or the kill switch is on.
    const safety = await adminRequest(config, 'GET', '/safety');
    if (safety.tripped) {
      process.stderr.write(`The safety layer of the proxy is tripped; the campaign stops here:\n${JSON.stringify(safety, null, 2)}\n` +
        'Check the upstreams, close the breaker (POST /safety/close) or resume (POST /safety/resume), and continue with --resume.\n');
      process.exit(2);
    }
    if (config.pauseMs) {
      await new Promise(resolve => setTimeout(resolve, config.pauseMs));
    }
  }
  process.stdout.write(`Done: ${runsPath}\nSummarize with: node harness/analyze.mjs results/${name}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });
}
