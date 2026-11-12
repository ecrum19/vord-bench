import { readdirSync, readFileSync } from 'node:fs';
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
]);

export const ENFORCEMENTS = new Set([
  'RejectRequest',
  'TruncateResult',
  'QueueRequest',
  'ThrottleResponse',
  'DegradeQuality',
]);

/**
 * Load all restriction profiles (*.json) from a directory.
 * @param {string} dir
 * @returns {Map<string, object>} Profiles by id.
 */
export function loadProfiles(dir) {
  const profiles = new Map();
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    const profile = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    validateProfile(profile, file);
    profiles.set(profile.id, profile);
  }
  return profiles;
}

/**
 * Check that a profile is well-formed, so that mistakes surface when the proxy starts.
 * @param {object} profile
 * @param {string} source A label for error messages.
 */
export function validateProfile(profile, source = profile.id) {
  if (typeof profile.id !== 'string' || !/^[\w-]+$/u.test(profile.id)) {
    throw new Error(`${source}: profile id must be a URL-safe string`);
  }
  const lists = [ profile.restrictions ?? [], ...Object.values(profile.endpoints ?? {}) ];
  for (const restrictions of lists) {
    for (const restriction of restrictions) {
      validateRestriction(restriction, source);
    }
  }
}

function validateRestriction(restriction, source) {
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
    maxValue: restriction.maxValue,
    burstValue: restriction.burstValue,
    windowMs,
    retryAfterMs: durationToMs(restriction.retryAfterHint),
    enforcement: restriction.enforcement ?? 'RejectRequest',
    hard: restriction.hardRestriction ?? true,
    statusCode: restriction.returnsStatusCode,
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
    lines.push('', ...restrictionTurtle(`<${endpointUrl}#${restriction.id}>`, restriction));
  }
  return `${lines.join('\n')}\n`;
}

function restrictionTurtle(subject, restriction) {
  const properties = [ `a vord:Restriction, vord:${restriction.type}` ];
  const term = value => value.includes(':') ? `<${value}>` : `vord:${value}`;
  const integer = value => `"${value}"^^xsd:integer`;
  const duration = value => `"${value}"^^xsd:duration`;
  if (restriction.metric) {
    properties.push(`vord:metric ${term(restriction.metric)}`);
  }
  for (const key of [ 'maxValue', 'minValue', 'burstValue', 'returnsStatusCode' ]) {
    if (restriction[key] !== undefined) {
      properties.push(`vord:${key} ${integer(restriction[key])}`);
    }
  }
  for (const key of [ 'windowDuration', 'retryAfterHint' ]) {
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
    properties.push(`vord:httpSignalHeader <${HTTP_HEADERS}${restriction.httpSignalHeader}>`);
  }
  return properties.map((property, i) =>
    `${i === 0 ? `${subject} ` : '  '}${property}${i === properties.length - 1 ? ' .' : ' ;'}`);
}
