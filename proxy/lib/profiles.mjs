import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durationToMs } from './duration.mjs';

const VORD = 'https://w3id.org/vord#';
const UNIT = 'http://qudt.org/vocab/unit/';
const HTTP_HEADERS = 'http://www.w3.org/2011/http-headers#';

export const RESTRICTION_TYPES = new Set([
  'RateRestriction',
  'QuotaRestriction',
  'ResultSizeRestriction',
  'CostModelRestriction',
  'ServerLoadRestriction',
  'ConcurrentRequestsRestriction',
  'ResponseTimeRestriction',
  'IdentificationRestriction',
]);

export const IDENTIFICATION_FORMATS = new Set([ 'EmailAddress', 'ProductWithContact' ]);

// Emulation parameters that the proxy uses but does not advertise, per restriction type.
const EMULATION_KEYS = {
  RateRestriction: [ 'queueLimit', 'delayPerExcessMs', 'background' ],
  QuotaRestriction: [ 'queueLimit' ],
  ResultSizeRestriction: [ 'silent', 'maxValueDistribution' ],
  CostModelRestriction: [ 'cost' ],
  ConcurrentRequestsRestriction: [ 'degradedState' ],
  ResponseTimeRestriction: [ 'degradedState' ],
  ServerLoadRestriction: [],
  IdentificationRestriction: [],
};

export const ENFORCEMENTS = new Set([
  'RejectRequest',
  'TruncateResult',
  'QueueRequest',
  'ThrottleResponse',
  'DegradeQuality',
]);

/**
 * Load the restriction archetypes (*.json) of a directory.
 * @param {string} dir
 * @returns {Map<string, object>} Archetypes by id.
 */
export function loadArchetypes(dir) {
  const archetypes = new Map();
  if (!existsSync(dir)) {
    return archetypes;
  }
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    const archetype = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (typeof archetype.id !== 'string' || !/^[\w-]+$/u.test(archetype.id)) {
      throw new Error(`${file}: archetype id must be a URL-safe string`);
    }
    for (const restriction of archetype.restrictions ?? []) {
      validateRestriction(restriction, `archetypes/${file}`);
    }
    archetypes.set(archetype.id, archetype);
  }
  return archetypes;
}

/**
 * Load all restriction profiles (*.json) from a directory, and the archetypes in its `archetypes` subdirectory.
 * Every archetype also becomes a profile `archetype-<id>`, in which every endpoint has that archetype.
 * Mix profiles get the archetypes they use, and one more profile `<id>-s<seed>` for every extra seed in `seeds`.
 * Mixes and drawn values are resolved per suite with resolveProfiles (lib/archetypes.mjs).
 * @param {string} dir
 * @returns {Map<string, object>} Profiles by id.
 */
export function loadProfiles(dir) {
  const profiles = new Map();
  const archetypes = loadArchetypes(join(dir, 'archetypes'));
  const add = (profile, source) => {
    if (profiles.has(profile.id)) {
      throw new Error(`${source}: duplicate profile id ${profile.id}`);
    }
    profiles.set(profile.id, profile);
  };
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    const profile = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    validateProfile(profile, file, archetypes);
    if (profile.mix) {
      const used = Object.fromEntries(Object.keys(profile.mix.shares).map(id => [ id, archetypes.get(id) ]));
      const seed = profile.mix.seed ?? 1;
      add({ ...profile, generic: true, archetypes: used }, file);
      for (const extra of (profile.seeds ?? []).filter(value => value !== seed)) {
        add({
          ...profile,
          id: `${profile.id}-s${extra}`,
          label: `${profile.label ?? profile.id} (seed ${extra})`,
          generic: true,
          archetypes: used,
          mix: { ...profile.mix, seed: extra },
        }, file);
      }
    } else {
      add(profile, file);
    }
  }
  for (const archetype of archetypes.values()) {
    add({
      id: `archetype-${archetype.id}`,
      label: `Every endpoint is ${archetype.label ?? archetype.id}`,
      generic: true,
      archetype: archetype.id,
      restrictions: archetype.restrictions ?? [],
    }, `archetypes/${archetype.id}.json`);
  }
  return profiles;
}

/**
 * Check that a profile is well-formed, so that mistakes surface when the proxy starts.
 * @param {object} profile
 * @param {string} source A label for error messages.
 */
export function validateProfile(profile, source = profile.id, archetypes = new Map()) {
  if (typeof profile.id !== 'string' || !/^[\w-]+$/u.test(profile.id)) {
    throw new Error(`${source}: profile id must be a URL-safe string`);
  }
  const lists = [ profile.restrictions ?? [], ...Object.values(profile.endpoints ?? {}) ];
  for (const restrictions of lists) {
    for (const restriction of restrictions) {
      validateRestriction(restriction, source);
    }
  }
  if (profile.mix) {
    if (profile.restrictions || profile.endpoints) {
      throw new Error(`${source}: a mix profile cannot also list restrictions or endpoints`);
    }
    const blockSize = profile.mix.blockSize ?? 20;
    const shares = Object.entries(profile.mix.shares ?? {});
    if (shares.length === 0) {
      throw new Error(`${source}: a mix needs shares`);
    }
    for (const [ id, count ] of shares) {
      if (!archetypes.has(id)) {
        throw new Error(`${source}: unknown archetype ${id} in the mix`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`${source}: the share of ${id} must be a count of endpoints per block`);
      }
    }
    const total = shares.reduce((sum, [ , count ]) => sum + count, 0);
    if (total !== blockSize) {
      throw new Error(`${source}: the shares add up to ${total}, not to the block size ${blockSize}`);
    }
  }
}

export function validateRestriction(restriction, source) {
  if (!/^[\w-]+$/u.test(restriction.id ?? '')) {
    throw new Error(`${source}: every restriction needs a URL-safe id`);
  }
  if (!RESTRICTION_TYPES.has(restriction.type)) {
    throw new Error(`${source}/${restriction.id}: unknown type ${restriction.type}`);
  }
  if (restriction.enforcement && !ENFORCEMENTS.has(restriction.enforcement)) {
    throw new Error(`${source}/${restriction.id}: unknown enforcement ${restriction.enforcement}`);
  }
  for (const key of [ 'windowDuration', 'retryAfterHint' ]) {
    if (restriction[key] !== undefined && durationToMs(restriction[key]) === undefined) {
      throw new Error(`${source}/${restriction.id}: invalid ${key} ${restriction[key]}`);
    }
  }
  if ([ 'RateRestriction', 'QuotaRestriction' ].includes(restriction.type) && !restriction.windowDuration &&
    restriction.metric !== 'requestsPerDay') {
    throw new Error(`${source}/${restriction.id}: rate and quota restrictions need a windowDuration`);
  }
  if (restriction.penaltyDuration !== undefined && durationToMs(restriction.penaltyDuration) === undefined) {
    throw new Error(`${source}/${restriction.id}: invalid penaltyDuration ${restriction.penaltyDuration}`);
  }
  if (restriction.penaltyThreshold !== undefined &&
    (!Number.isInteger(restriction.penaltyThreshold) || restriction.penaltyThreshold < 1 || !restriction.penaltyDuration)) {
    throw new Error(`${source}/${restriction.id}: penaltyThreshold must be an integer of at least 1, with a penaltyDuration`);
  }
  if (restriction.type === 'IdentificationRestriction' &&
    (!restriction.identificationHeader || !IDENTIFICATION_FORMATS.has(restriction.identificationFormat))) {
    throw new Error(`${source}/${restriction.id}: identification restrictions need an identificationHeader and ` +
      `an identificationFormat (${[ ...IDENTIFICATION_FORMATS ].join(' or ')})`);
  }
  if (restriction.type === 'CostModelRestriction' && restriction.metric === 'costUnitsPerWindow' &&
    (!restriction.windowDuration || !restriction.costModel)) {
    throw new Error(`${source}/${restriction.id}: usage budgets need a windowDuration and a costModel`);
  }
  for (const key of Object.keys(restriction.emulation ?? {})) {
    if (!EMULATION_KEYS[restriction.type].includes(key)) {
      throw new Error(`${source}/${restriction.id}: unknown emulation parameter ${key} for ${restriction.type}`);
    }
  }
}

/**
 * Get the restrictions of a profile that apply to an endpoint.
 * A profile either lists the same restrictions for every endpoint,
 * or lists restrictions per endpoint (endpoints without an entry are unrestricted).
 * @param {object} profile
 * @param {string} endpointName
 * @returns {object[]}
 */
export function restrictionsFor(profile, endpointName) {
  if (profile.endpoints) {
    return profile.endpoints[endpointName] ?? [];
  }
  if (profile.mix) {
    throw new Error(`Profile ${profile.id} is a mix, which must first be resolved for the endpoints of a suite`);
  }
  return profile.restrictions ?? [];
}

/**
 * Turn a restriction description into the values the proxy enforces.
 * @param {object} restriction
 */
export function normalizeRestriction(restriction) {
  let windowMs = durationToMs(restriction.windowDuration);
  if (windowMs === undefined && restriction.metric === 'requestsPerDay') {
    windowMs = 24 * 60 * 60 * 1_000;
  }
  return {
    id: restriction.id,
    type: restriction.type,
    metric: restriction.metric,
    maxValue: restriction.maxValue,
    burstValue: restriction.burstValue,
    windowMs,
    retryAfterMs: durationToMs(restriction.retryAfterHint),
    enforcement: restriction.enforcement ?? 'RejectRequest',
    hard: restriction.hardRestriction ?? true,
    statusCode: restriction.returnsStatusCode,
    scope: restriction.scope,
    signalHeader: restriction.httpSignalHeader?.toLowerCase(),
    penaltyThreshold: restriction.penaltyThreshold,
    penaltyMs: durationToMs(restriction.penaltyDuration),
    identificationHeader: restriction.identificationHeader?.toLowerCase(),
    identificationFormat: restriction.identificationFormat,
    emulation: restriction.emulation ?? {},
  };
}

/**
 * Serialize the SPARQL service description of an endpoint, with the VoRD restrictions of a profile.
 * Profiles with advertise=false enforce their restrictions without describing them.
 * @param {string} endpointUrl The public URL of the endpoint.
 * @param {object} profile
 * @param {string} endpointName
 * @returns {string} Turtle.
 */
export function serviceDescription(endpointUrl, profile, endpointName) {
  const restrictions = profile.advertise === false ? [] : restrictionsFor(profile, endpointName);
  const service = `<${endpointUrl}#service>`;
  const lines = [
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '@prefix sd: <http://www.w3.org/ns/sparql-service-description#> .',
    `@prefix vord: <${VORD}> .`,
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `${service} a sd:Service ;`,
    `  sd:endpoint <${endpointUrl}> ;`,
    '  sd:supportedLanguage sd:SPARQL11Query ;',
    `  sd:resultFormat <http://www.w3.org/ns/formats/SPARQL_Results_JSON>, <http://www.w3.org/ns/formats/N-Triples>${restrictions.length > 0 ? ' ;' : ' .'}`,
  ];
  if (restrictions.length > 0) {
    lines.push(`  vord:hasRestriction ${restrictions.map(r => `<${endpointUrl}#${r.id}>`).join(', ')} .`);
  }
  for (const restriction of restrictions) {
    lines.push('', ...restrictionTurtle(`<${endpointUrl}#${restriction.id}>`, restriction, endpointUrl));
  }
  return `${lines.join('\n')}\n`;
}

function restrictionTurtle(subject, restriction, endpointUrl) {
  const properties = [ `a vord:Restriction, vord:${restriction.type}` ];
  const term = value => value.includes(':') ? `<${value}>` : `vord:${value}`;
  const integer = value => `"${value}"^^xsd:integer`;
  const duration = value => `"${value}"^^xsd:duration`;
  if (restriction.metric) {
    properties.push(`vord:metric ${term(restriction.metric)}`);
  }
  for (const key of [ 'maxValue', 'minValue', 'burstValue', 'returnsStatusCode', 'penaltyThreshold' ]) {
    if (restriction[key] !== undefined) {
      properties.push(`vord:${key} ${integer(restriction[key])}`);
    }
  }
  for (const key of [ 'windowDuration', 'retryAfterHint', 'penaltyDuration' ]) {
    if (restriction[key] !== undefined) {
      properties.push(`vord:${key} ${duration(restriction[key])}`);
    }
  }
  if (restriction.unit) {
    properties.push(`vord:unit <${UNIT}${restriction.unit}>`);
  }
  if (restriction.scope) {
    properties.push(`vord:hasScope ${term(restriction.scope)}`);
  }
  if (restriction.enforcement) {
    properties.push(`vord:enforcement vord:${restriction.enforcement}`);
  }
  if (restriction.hardRestriction !== undefined) {
    properties.push(`vord:hardRestriction "${Boolean(restriction.hardRestriction)}"^^xsd:boolean`);
  }
  if (restriction.httpSignalHeader) {
    properties.push(`vord:httpSignalHeader <${HTTP_HEADERS}${restriction.httpSignalHeader.toLowerCase()}>`);
  }
  if (restriction.identificationHeader) {
    properties.push(`vord:identificationHeader <${HTTP_HEADERS}${restriction.identificationHeader.toLowerCase()}>`);
  }
  if (restriction.identificationFormat) {
    properties.push(`vord:identificationFormat vord:${restriction.identificationFormat}`);
  }
  // A cost model is either an IRI, or a local name that is described along with the restriction.
  const costModel = restriction.costModel && (restriction.costModel.includes(':') ?
    `<${restriction.costModel}>` :
    `<${endpointUrl}#${restriction.costModel}>`);
  if (costModel) {
    properties.push(`vord:costModel ${costModel}`);
  }
  const lines = properties.map((property, i) =>
    `${i === 0 ? `${subject} ` : '  '}${property}${i === properties.length - 1 ? ' .' : ' ;'}`);
  if (costModel && !restriction.costModel.includes(':')) {
    const description = restriction.costModelDescription ?
      ` ;\n  dcterms:description ${JSON.stringify(restriction.costModelDescription)}@en` :
      '';
    lines.push('', `${costModel} a vord:CostModel${description} .`);
  }
  return lines;
}
