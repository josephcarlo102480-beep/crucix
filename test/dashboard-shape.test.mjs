// Data-contract test between dashboard/inject.mjs synthesize() and the fields
// dashboard/public/jarvis.html actually reads. The review found three silent
// mismatches (acled.regions, ISS altitude, WHO url) — each is pinned here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesize } from '../dashboard/inject.mjs';

const html = readFileSync(join(process.cwd(), 'dashboard/public/jarvis.html'), 'utf8');

const ISS_LINE1 = '1 25544U 98067A   24001.50000000  .00016717  00000+0  10270-3 0  9004';
const ISS_LINE2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

async function build() {
  return synthesize({
    crucix: { timestamp: new Date().toISOString() },
    sources: {
      OpenSky: {},
      ACLED: {
        totalEvents: 12, totalFatalities: 3,
        byRegion: { 'Middle East': 7, 'Eastern Europe': 5 },
        byType: { Battles: 8, Protests: 4 },
      },
      Space: {
        iss: { name: 'ISS (ZARYA)', noradId: 25544, line1: ISS_LINE1, line2: ISS_LINE2, apogee: 420, perigee: 410 },
        spaceStations: [],
        militarySatellites: 3, militaryByCountry: { US: 2, CIS: 1 },
        constellations: { starlink: 1, oneweb: 1 }, signals: [],
      },
      WHO: { diseaseOutbreakNews: [{ title: 'Outbreak', date: '2026-09-01', summary: 's', url: 'https://www.who.int/emergencies/item/x' }] },
    },
    errors: [],
  });
}

describe('dashboard data contract', () => {
  it('emits acled.regions as a plottable array, which the Conflict Events layer reads', async () => {
    const D = await build();
    assert.ok(Array.isArray(D.acled.regions) && D.acled.regions.length > 0);
    assert.match(html, /D\.acled\.regions|merged\.acled\.regions/);
  });

  it('gives the ISS an altitude the page can format', async () => {
    const D = await build();
    assert.equal(D.space.iss.altitudeKm, 415);
    assert.equal(D.space.iss.apogee, 420);
    assert.match(html, /issAltitudeKm\(/);
    assert.ok(D.space.issPosition && Number.isFinite(D.space.issPosition.lat), 'ISS subpoint propagated from TLE');
  });

  it('keeps the WHO bulletin url for the OSINT "Open source" link', async () => {
    const D = await build();
    assert.equal(D.who[0].url, 'https://www.who.int/emergencies/item/x');
  });

  it('exposes every top-level key jarvis.html dereferences on D', async () => {
    const D = await build();
    // `delta` is attached by server.mjs after synthesize(), not by synthesize() itself.
    const addedByServer = new Set(['delta']);
    const keys = new Set([...html.matchAll(/\bD\.([a-zA-Z_]+)/g)].map(m => m[1]));
    const missing = [...keys].filter(k => !addedByServer.has(k) && !(k in D));
    assert.deepEqual(missing, [], `jarvis.html reads D.${missing.join(', D.')} which synthesize() never emits`);
  });
});
