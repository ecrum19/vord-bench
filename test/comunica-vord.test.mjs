/**
 * Checks that the service descriptions of the proxy are read as intended by the VoRD extractor of the Comunica fork.
 * Skipped if the fork is not available (set COMUNICA_DIR, default ../comunica-vord).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProfiles, serviceDescription } from '../proxy/lib/profiles.mjs';

const comunicaDir = resolve(fileURLToPath(new URL('..', import.meta.url)), process.env.COMUNICA_DIR ?? '../comunica-vord');
const extractorPath = join(comunicaDir, 'packages/actor-rdf-metadata-extract-vord/lib/index.js');
const available = existsSync(extractorPath);

describe('VoRD extraction by the Comunica fork', { skip: available ? false : `no built fork at ${comunicaDir}` }, () => {
  const comunicaRequire = createRequire(join(comunicaDir, 'packages/actor-rdf-metadata-extract-vord/package.json'));
  const profiles = loadProfiles(fileURLToPath(new URL('../profiles', import.meta.url)));

  async function extract(profileId, endpointName) {
    const { ActorRdfMetadataExtractVord } = comunicaRequire('./lib/index.js');
    const { Bus } = comunicaRequire('@comunica/core');
    const { ActionContext } = comunicaRequire('@comunica/core');
    const { StreamParser } = comunicaRequire('n3');
    const url = `http://localhost:3001/${profileId}/sparql`;
    const metadata = Readable.from([ serviceDescription(url, profiles.get(profileId), endpointName) ])
      .pipe(new StreamParser({ format: 'text/turtle' }));
    const actor = new ActorRdfMetadataExtractVord({ name: 'actor', bus: new Bus({ name: 'bus' }) });
    const { metadata: output } = await actor.run({ url, metadata, requestTime: 0, context: new ActionContext() });
    return output.restrictions ?? [];
  }

  it('reads the strict rate profile', async() => {
    assert.deepEqual(await extract('P1-rate', 'all'), [{
      type: 'rate',
      metric: 'https://w3id.org/vord#requestsPerWindow',
      maxValue: 10,
      windowDuration: 6_000,
      unit: 'http://qudt.org/vocab/unit/COUNT',
      scope: 'https://w3id.org/vord#PerClientIP',
      enforcement: 'reject',
      hardRestriction: true,
      returnsStatusCode: 429,
      httpSignalHeader: 'retry-after',
    }]);
  });

  it('reads every restriction of the combined profile', async() => {
    const restrictions = await extract('P6-combined', 'all');
    assert.deepEqual(restrictions.map(restriction => restriction.type).sort(), [
      'concurrentRequests', 'quota', 'rate', 'responseTime', 'resultSize',
    ]);
    const rate = restrictions.find(restriction => restriction.type === 'rate');
    assert.equal(rate.burstValue, 10);
    assert.equal(rate.retryAfterHint, 2_000);
    assert.equal(restrictions.find(restriction => restriction.type === 'quota').hardRestriction, false);
    assert.equal(restrictions.find(restriction => restriction.type === 'resultSize').enforcement, 'truncate');
    assert.equal(restrictions.find(restriction => restriction.type === 'responseTime').maxValue, 2);
  });

  it('reads per-endpoint restrictions, and none for unadvertised profiles', async() => {
    assert.deepEqual((await extract('P7-mixed', 'offers')).map(restriction => restriction.type), [ 'rate', 'concurrentRequests' ]);
    assert.deepEqual(await extract('P7-mixed', 'reviews'), []);
    assert.deepEqual(await extract('P8-unadvertised', 'all'), []);
    assert.deepEqual(await extract('P0-none', 'all'), []);
  });
});
