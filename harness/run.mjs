#!/usr/bin/env node
/**
 * Run the benchmark: profiles x scenarios x queries x replications x engines.
 * Every run uses a fresh process, after the proxy's limiter state is reset.
 *
 * Usage: node harness/run.mjs [--config bench.config.json] [--name <name>] [--dry-run] [--resume]
 *   [--profiles P1-rate,...] [--scenarios single,federated] [--engines A-naive,...]
 *   [--templates L1,...] [--instances n] [--replications n] [--timeout ms]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProfiles } from '../proxy/lib/profiles.mjs';
import { ROOT, fromRoot, loadBenchConfig, loadEngineManifest, parseList } from './lib/config.mjs';
import { loadQueries } from './lib/queries.mjs';

/**
 * Build the ordered list of runs.
 * Engines are interleaved per query and rotated per replication, so that drift in the machine's load
 * affects all engines alike.
 */
export function buildPlan({ profiles, scenarios, engines, queries, replications }) {
  const runs = [];
  for (const profile of profiles) {
    for (const scenario of scenarios) {
      if (profile.scenarios && !profile.scenarios.includes(scenario)) {
        continue;
      }
      for (const query of queries) {
        for (let rep = 0; rep < replications; rep++) {
          for (let i = 0; i < engines.length; i++) {
            const engine = engines[(i + rep) % engines.length];
            runs.push({
              runId: `${profile.id}__${scenario}__${query.id}__r${rep}__${engine}`,
              profile: profile.id,
              scenario,
              query,
              rep,
              engine,
            });
          }
        }
      }
    }
  }
  return runs;
}

/**
 * The source URLs of a scenario under a profile.
 */
export function sourcesFor(config, scenario, profileId) {
  return config.scenarios[scenario].map(endpoint =>
    `${config.proxy.baseUrl}:${config.endpoints[endpoint].port}/${profileId}/sparql`);
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
  const profiles = pick(values.profiles, config.profiles, [ ...allProfiles.keys() ], 'profile')
    .map(id => allProfiles.get(id));
  const scenarios = pick(values.scenarios, Object.keys(config.scenarios), Object.keys(config.scenarios), 'scenario');
  const engineIds = Object.keys(JSON.parse(readFileSync(fromRoot('engines/engines.json'), 'utf8')).engines);
  const engines = pick(values.engines, config.engines, engineIds, 'engine');
  const queries = loadQueries(fromRoot(config.queries.dir), {
    templates: parseList(values.templates) ?? config.queries.templates,
    instances: values.instances ? Number(values.instances) : config.queries.instances,
  });
  const replications = values.replications ? Number(values.replications) : config.replications;
  return { profiles, scenarios, engines, queries, replications };
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
    byProfile[`${run.profile} / ${run.scenario}`] = (byProfile[`${run.profile} / ${run.scenario}`] ?? 0) + 1;
  }
  const out = lines => process.stdout.write(`${lines.join('\n')}\n`);
  out([
    `Runs: ${plan.length} = ${Object.keys(byProfile).length} profile/scenario pairs x ${selected.queries.length} queries x ${selected.replications} replications x ${selected.engines.length} engines`,
    `Engines: ${selected.engines.join(', ')}`,
    `Queries: ${selected.queries.map(query => query.id).join(', ')}`,
    'Runs per profile / scenario:',
    ...Object.entries(byProfile).map(([ key, count ]) => `  ${key}: ${count}`),
    `Worst case (every run times out after ${timeoutMs / 1_000} s): ${(plan.length * timeoutMs / 3_600_000).toFixed(1)} h`,
    `Example sources (${plan[0]?.scenario}): ${plan[0] ? sourcesFor(config, plan[0].scenario, plan[0].profile).join(' ') : '-'}`,
    '',
    'Checks:',
  ]);
  const checks = [];
  try {
    const manifest = loadEngineManifest();
    const missing = selected.engines.filter(engine => !manifest.engines[engine]);
    checks.push([ missing.length === 0, `engines generated from ${manifest.comunicaBranch}@${manifest.comunicaCommit.slice(0, 9)}${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}` ]);
  } catch (error) {
    checks.push([ false, error.message ]);
  }
  const missingTruth = selected.queries.filter(query => !existsSync(join(fromRoot(config.groundTruth.dir), `${query.id}.json`)));
  checks.push([ missingTruth.length === 0, missingTruth.length === 0 ?
    'ground truth present for all queries' :
    `ground truth missing for ${missingTruth.map(query => query.id).join(', ')} (npm run ground-truth)` ]);
  const health = await proxyHealth(config);
  checks.push([ Boolean(health), health ? `proxy up with profiles ${health.profiles.join(', ')}` : `proxy not reachable at ${config.proxy.adminUrl} (docker compose up -d)` ]);
  checks.push([ existsSync(join(config.comunicaDir, 'node_modules')), `Comunica fork at ${config.comunicaDir}` ]);
  out(checks.map(([ ok, message ]) => `  ${ok ? 'ok  ' : 'FAIL'} ${message}`));
  return checks.every(([ ok ]) => ok);
}

/**
 * Execute one run in a child process.
 * @returns {Promise<object>} The run's measurements.
 */
async function execute(config, manifest, run, { outDir, timeoutMs, trace }) {
  const engine = manifest.engines[run.engine];
  const jobsDir = join(outDir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const jobPath = join(jobsDir, `${run.runId}.job.json`);
  const outPath = join(jobsDir, `${run.runId}.out.json`);
  rmSync(outPath, { force: true });
  writeFileSync(jobPath, JSON.stringify({
    comunicaDir: config.comunicaDir,
    compiled: engine.compiled,
    config: engine.config,
    context: engine.context,
    sources: sourcesFor(config, run.scenario, run.profile),
    query: run.query.query,
    groundTruth: join(fromRoot(config.groundTruth.dir), `${run.query.id}.json`),
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
      config: { type: 'string', default: 'bench.config.json' },
      name: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      profiles: { type: 'string' },
      scenarios: { type: 'string' },
      engines: { type: 'string' },
      templates: { type: 'string' },
      instances: { type: 'string' },
      replications: { type: 'string' },
      timeout: { type: 'string' },
      trace: { type: 'boolean' },
    },
  });
  const config = loadBenchConfig(values.config);
  const selected = selection(values, config);
  const plan = buildPlan(selected);
  const timeoutMs = values.timeout ? Number(values.timeout) : config.timeoutMs;

  if (values['dry-run']) {
    const ok = await dryRun(config, plan, selected, timeoutMs);
    process.exit(ok ? 0 : 1);
  }

  const manifest = loadEngineManifest();
  if (!await proxyHealth(config)) {
    throw new Error(`The proxy is not reachable at ${config.proxy.adminUrl}; start it with "docker compose up -d"`);
  }
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
    config,
    selection: { ...selected, profiles: selected.profiles.map(profile => profile.id), queries: selected.queries.map(query => query.id) },
    timeoutMs,
    comunica: { branch: manifest.comunicaBranch, commit: manifest.comunicaCommit },
  }, null, 2)}\n`);
  const trace = values.trace ?? config.trace ?? false;

  if (config.warmup && done.size === 0) {
    // One unrecorded, unrestricted run per engine, so that the stores' caches are warm before measuring.
    for (const engine of selected.engines) {
      const run = { runId: `warmup__${engine}`, profile: 'P0-none', scenario: selected.scenarios[0], query: selected.queries[0], rep: 0, engine };
      await adminRequest(config, 'POST', `/reset?run=${encodeURIComponent(run.runId)}`);
      const result = await execute(config, manifest, run, { outDir, timeoutMs, trace: false });
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
    const result = await execute(config, manifest, run, { outDir, timeoutMs, trace });
    const server = await adminRequest(config, 'GET', `/stats?run=${encodeURIComponent(run.runId)}`);
    const record = {
      runId: run.runId,
      profile: run.profile,
      scenario: run.scenario,
      engine: run.engine,
      query: run.query.id,
      template: run.query.template,
      rep: run.rep,
      startedAt,
      ...result,
      server,
    };
    appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
    process.stdout.write(`[${index}/${plan.length}] ${run.profile} ${run.scenario} ${run.query.id} r${run.rep} ${run.engine}: ${describe(result)}\n`);
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
