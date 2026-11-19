#!/usr/bin/env node
/**
 * Generate the Components.js config of every engine in engines/engines.json from the Comunica fork's
 * default config, and compile each config into a module, so that runs do not instantiate configs themselves.
 * Usage: node harness/generate-engines.mjs [--suite watdiv] [--no-compile]
 *
 * Engine isolation: only engines with providedRestrictions in engines.json may contain the context actor that reads
 * the endpointRestrictions context entry; the others remove it with replaceImports. The compiled engines are checked
 * for this, so that restrictions provided to the VoRD engines can never reach the regular ones.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fromRoot, readJson } from './lib/config.mjs';
import { loadSuite } from './lib/suites.mjs';

const CONTEXTS = [
  'https://linkedsoftwaredependencies.org/bundles/npm/componentsjs/^6.0.0/components/context.jsonld',
  'https://linkedsoftwaredependencies.org/bundles/npm/@comunica/config-query-sparql/^5.0.0/components/context.jsonld',
];

/**
 * Build the config of one engine.
 * @param {{ import: string[] }} baseConfig
 * @param {object} engine An entry of engines.json.
 */
export function buildEngineConfig(baseConfig, engine) {
  const imports = [ ...baseConfig.import ];
  for (const [ original, replacements ] of Object.entries(engine.replaceImports ?? {})) {
    const index = imports.indexOf(original);
    if (index < 0) {
      throw new Error(`The base config does not import ${original}`);
    }
    imports.splice(index, 1, ...replacements);
  }
  return {
    '@context': [ ...CONTEXTS, ...engine.contexts ?? [] ],
    import: imports,
    ...engine.overrides ? { '@graph': engine.overrides } : {},
  };
}

/**
 * The package of the context actor that reads provided restrictions.
 */
export const PROVIDED_RESTRICTIONS_ACTOR = '@comunica/actor-context-preprocess-endpoint-restrictions';

/**
 * Check that a compiled engine contains the actor that reads provided restrictions if and only if it should.
 * @param {string} id
 * @param {{ providedRestrictions?: boolean }} engine
 * @param {string} compiled The compiled engine module.
 */
export function checkIsolation(id, engine, compiled) {
  const contains = compiled.includes(PROVIDED_RESTRICTIONS_ACTOR);
  if (contains !== Boolean(engine.providedRestrictions)) {
    throw new Error(`Engine ${id} ${contains ? 'reads' : 'does not read'} provided restrictions, but its definition says ` +
      `providedRestrictions: ${Boolean(engine.providedRestrictions)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'watdiv' },
      'no-compile': { type: 'boolean', default: false },
    },
  });
  const config = loadSuite(values.suite);
  const definitions = readJson('engines/engines.json');
  const basePath = join(config.comunicaDir, definitions.baseConfig);
  if (!existsSync(basePath)) {
    throw new Error(`Base config ${basePath} not found; is COMUNICA_DIR (${config.comunicaDir}) the VoRD fork?`);
  }
  const baseConfig = JSON.parse(readFileSync(basePath, 'utf8'));
  const outDir = fromRoot('engines/generated');
  mkdirSync(outDir, { recursive: true });

  const git = args => execFileSync('git', args, { cwd: config.comunicaDir, encoding: 'utf8' }).trim();
  const manifest = {
    generatedAt: new Date().toISOString(),
    comunicaDir: config.comunicaDir,
    comunicaBranch: git([ 'rev-parse', '--abbrev-ref', 'HEAD' ]),
    comunicaCommit: git([ 'rev-parse', 'HEAD' ]),
    engines: {},
  };

  for (const [ id, engine ] of Object.entries(definitions.engines)) {
    const configPath = join(outDir, `${id}.json`);
    writeFileSync(configPath, `${JSON.stringify(buildEngineConfig(baseConfig, engine), null, 2)}\n`);
    let compiledPath;
    if (!values['no-compile']) {
      process.stdout.write(`Compiling ${id}... `);
      const compiled = execFileSync(process.execPath, [
        join(config.comunicaDir, 'packages/runner/bin/compile-config.js'),
        configPath,
      ], { cwd: join(config.comunicaDir, 'engines/query-sparql'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      compiledPath = join(outDir, `${id}.cjs`);
      writeFileSync(compiledPath, compiled);
      checkIsolation(id, engine, compiled);
      process.stdout.write('done\n');
    }
    manifest.engines[id] = {
      label: engine.label,
      config: configPath,
      compiled: compiledPath,
      context: engine.context ?? {},
      providedRestrictions: Boolean(engine.providedRestrictions),
    };
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Generated ${Object.keys(manifest.engines).length} engines for ${manifest.comunicaBranch}@${manifest.comunicaCommit.slice(0, 9)}\n`);
}
