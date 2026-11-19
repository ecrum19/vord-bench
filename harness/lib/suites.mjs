import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, fromRoot, readJson } from './config.mjs';
import { loadQueries } from './queries.mjs';

/**
 * Suites that are planned but not implemented yet (PLAN-SUITES.md, section 6).
 */
export const PLANNED_SUITES = {
  fedshop: 'phase 3 of PLAN-SUITES.md',
  largerdfbench: 'phase 5 of PLAN-SUITES.md',
  realworld: 'phase 6 of PLAN-SUITES.md',
};

/**
 * Settings of a preset, with their defaults.
 */
const PRESET_DEFAULTS = {
  templates: [],
  instances: 1,
  descriptions: [ 'advertised' ],
  replications: 1,
  timeoutMs: 300_000,
  warmup: false,
  pauseMs: 200,
  maxMemoryMb: 4096,
  trace: false,
};

/**
 * Readers of the queries of a suite.
 * Each takes the suite configuration and the selection, and returns { id, template, instance, query }[].
 */
export const QUERY_READERS = {
  watdiv(config, { templates, instances }) {
    const countsPath = join(fromRoot(config.groundTruth.dir), 'summary.json');
    return loadQueries(fromRoot(config.queries.dir), {
      templates,
      instances,
      counts: config.queries.preferNonEmpty && existsSync(countsPath) ?
        JSON.parse(readFileSync(countsPath, 'utf8')) :
        undefined,
    });
  },
};

/**
 * The strategies for the sources of a query. Each returns the names of the endpoints (federation members)
 * that a query is evaluated over, per scenario.
 */
export const SOURCE_STRATEGIES = {
  // The same endpoints for every query, per scenario.
  scenarios: {
    scenarios: config => Object.keys(config.sources.scenarios),
    members: (config, scenario) => config.sources.scenarios[scenario],
  },
};

/**
 * The strategies for the expected results of a query.
 */
export const GROUND_TRUTH_STRATEGIES = {
  // Computed by the harness on an unrestricted store (harness/ground-truth.mjs).
  compute: {
    path: (config, query) => join(fromRoot(config.groundTruth.dir), `${query.id}.json`),
  },
};

/**
 * The names of the suites in suites/.
 */
export function listSuites() {
  const dir = fromRoot('suites');
  return existsSync(dir) ?
    readdirSync(dir).filter(name => existsSync(join(dir, name, 'suite.json'))).sort() :
    [];
}

/**
 * Load a suite with one of its presets, into the configuration that the harness uses.
 * The COMUNICA_DIR environment variable overrides the configured Comunica checkout.
 * @param {string} name A suite in suites/.
 * @param {string} [presetName] A preset of the suite (its default if omitted).
 */
export function loadSuite(name = 'watdiv', presetName) {
  const path = `suites/${name}/suite.json`;
  if (!existsSync(fromRoot(path))) {
    if (PLANNED_SUITES[name]) {
      throw new Error(`The suite ${name} is planned but not implemented yet (${PLANNED_SUITES[name]})`);
    }
    throw new Error(`Unknown suite ${name}; available: ${listSuites().join(', ')}`);
  }
  const suite = readJson(path);
  const preset = presetName ?? suite.defaultPreset;
  if (!suite.presets?.[preset]) {
    throw new Error(`Unknown preset ${preset} of suite ${name}; available: ${Object.keys(suite.presets ?? {}).join(', ')}`);
  }
  const settings = { ...PRESET_DEFAULTS, ...suite.presets[preset] };
  for (const [ kind, registry, strategy ] of [
    [ 'query reader', QUERY_READERS, suite.queries.reader ],
    [ 'source strategy', SOURCE_STRATEGIES, suite.sources.strategy ],
    [ 'ground truth strategy', GROUND_TRUTH_STRATEGIES, suite.groundTruth.strategy ],
  ]) {
    if (!registry[strategy]) {
      throw new Error(`Suite ${name}: unknown ${kind} ${strategy}; available: ${Object.keys(registry).join(', ')}`);
    }
  }
  const config = {
    suite: name,
    preset,
    description: settings.description,
    comunicaDir: resolve(ROOT, process.env.COMUNICA_DIR ?? suite.comunicaDir),
    compose: suite.compose,
    proxy: suite.proxy,
    queries: { ...suite.queries, templates: settings.templates, instances: settings.instances },
    sources: suite.sources,
    groundTruth: suite.groundTruth,
    suiteProfiles: suite.profiles,
    profiles: settings.profiles ?? suite.profiles,
    engines: settings.engines,
    descriptions: settings.descriptions,
    replications: settings.replications,
    timeoutMs: settings.timeoutMs,
    warmup: settings.warmup,
    pauseMs: settings.pauseMs,
    maxMemoryMb: settings.maxMemoryMb,
    trace: settings.trace,
  };
  for (const profile of config.profiles) {
    if (!suite.profiles.includes(profile)) {
      throw new Error(`Preset ${preset} of suite ${name} uses profile ${profile}, which is not in the suite's profile set`);
    }
  }
  config.endpoints = readJson(config.proxy.endpointsFile).endpoints;
  return config;
}

/**
 * Read the queries of a suite.
 * @param {object} config A loaded suite.
 * @param {{ templates?: string[], instances?: number }} selection
 */
export function readQueries(config, selection) {
  return QUERY_READERS[config.queries.reader](config, selection);
}

/**
 * The scenarios of a suite.
 * @param {object} config A loaded suite.
 */
export function scenariosOf(config) {
  return SOURCE_STRATEGIES[config.sources.strategy].scenarios(config);
}

/**
 * The endpoints (members) that a query is evaluated over in a scenario.
 * @param {object} config A loaded suite.
 * @param {string} scenario
 */
export function membersOf(config, scenario) {
  return SOURCE_STRATEGIES[config.sources.strategy].members(config, scenario);
}

/**
 * The path of the expected results of a query.
 * @param {object} config A loaded suite.
 * @param {{ id: string }} query
 */
export function groundTruthPath(config, query) {
  return GROUND_TRUTH_STRATEGIES[config.groundTruth.strategy].path(config, query);
}
