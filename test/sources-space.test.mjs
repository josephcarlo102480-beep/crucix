// Space source — runs against a stub catalogue, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beforeEach } from 'node:test';
import { briefing, clearRecentLaunchCache, countryFromName, launchFromDesignator, launchFromTle, orbitFromTle } from '../apis/sources/space.mjs';

const ISS = {
  id: 25544, name: 'ISS (ZARYA)', epoch: Date.now() - 3600e3,
  line1: '1 25544U 98067A   24001.50000000  .00016717  00000+0  10270-3 0  9004',
  line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
};
const TIANGONG = { ...ISS, id: 48274, name: 'CSS (TIANHE)', line1: '1 48274U 21035A   24001.50000000  .00016717  00000+0  10270-3 0  9004' };
const NEW_PRC = { ...ISS, id: 60001, name: 'YAOGAN-43 01A', line1: '1 60001U 25120A   24001.50000000  .00016717  00000+0  10270-3 0  9004' };
const NEW_US = { ...ISS, id: 60002, name: 'STARLINK-32000', line1: '1 60002U 25121B   24001.50000000  .00016717  00000+0  10270-3 0  9004' };

// CelesTrak OMM records, as GROUP=last-30-days&FORMAT=json returns them.
const RECENT_OMM = [
  { OBJECT_NAME: 'YAOGAN-43 01A', OBJECT_ID: '2025-120A', NORAD_CAT_ID: 60001, EPOCH: '2026-09-01T13:10:45.683904', MEAN_MOTION: 15.2, ECCENTRICITY: 0.0004, INCLINATION: 35.0 },
  { OBJECT_NAME: 'STARLINK-32000', OBJECT_ID: '2025-121B', NORAD_CAT_ID: 60002, EPOCH: '2026-08-31T13:10:45.683904', MEAN_MOTION: 15.06, ECCENTRICITY: 0.0001, INCLINATION: 53.0 },
];
const recentOk = async () => RECENT_OMM;
const recentDown = async () => ({ error: 'HTTP 503', status: 503 });

function stubCatalogue(overrides = {}) {
  const groups = {
    stations: { total: 2, sats: [ISS, TIANGONG] },
    military: { total: 3, sats: [{ ...ISS, id: 1, name: 'USA 326' }, { ...ISS, id: 2, name: 'COSMOS 2558' }, NEW_PRC] },
    starlink: { total: 7000, sats: [] },
    oneweb: { total: 600, sats: [] },
    ...overrides,
  };
  return async (id) => {
    const g = groups[id];
    if (g instanceof Error) throw g;
    return g;
  };
}

describe('space source', () => {
  beforeEach(() => clearRecentLaunchCache());

  it('derives orbit geometry from TLE line 2', () => {
    const o = orbitFromTle(ISS.line2);
    // 15.7213 rev/day, e = 0.00067 → a ≈ 6732 km → roughly 365 × 356 km.
    assert.ok(o.apogee > 360 && o.apogee < 370, `apogee ${o.apogee}`);
    assert.ok(o.perigee > 351 && o.perigee < 361, `perigee ${o.perigee}`);
    assert.ok(o.apogee > o.perigee);
    assert.ok(o.periodMin > 91 && o.periodMin < 93);
    assert.equal(o.inclination, 51.64);
    assert.equal(orbitFromTle('garbage'), null);
  });

  it('reads the launch id from the international designator', () => {
    assert.deepEqual(launchFromTle(ISS.line1), { designator: '98067A', launchId: '1998-067', year: 1998, piece: 'A' });
    assert.equal(launchFromTle(NEW_PRC.line1).year, 2025);
    assert.equal(launchFromTle(''), null);
    assert.equal(launchFromDesignator('2026-176A').launchId, '2026-176');
  });

  it('attributes operators from the catalogue name', () => {
    assert.equal(countryFromName('STARLINK-1234'), 'US');
    assert.equal(countryFromName('COSMOS 2558'), 'CIS');
    assert.equal(countryFromName('YAOGAN-43 01A'), 'PRC');
    assert.equal(countryFromName('ONEWEB-0500'), 'EU');
    assert.equal(countryFromName('MYSTERY OBJECT'), 'OTHER');
  });

  it('builds the briefing from the shared catalogue', async () => {
    const data = await briefing({ loadGroup: stubCatalogue(), fetchImpl: recentOk });
    assert.equal(data.status, 'active');
    assert.equal(data.error, undefined);
    assert.equal(data.totalNewObjects, 2);
    assert.equal(data.distinctLaunches, 2);
    assert.deepEqual(data.launchByCountry, { PRC: 1, US: 1 });
    assert.equal(data.recentLaunches[0].name, 'YAOGAN-43 01A');
    assert.equal(data.recentLaunches[0].launchId, '2025-120');
    assert.ok(data.recentLaunches[0].altitudeKm > 500 && data.recentLaunches[0].altitudeKm < 600, 'recent launch has orbit geometry');
    assert.equal(data.iss.noradId, 25544);
    assert.ok(data.iss.apogee > 0 && data.iss.perigee > 0 && data.iss.altitudeKm > 0, 'ISS carries orbit geometry');
    assert.equal(data.iss.line1, ISS.line1);
    assert.deepEqual(data.spaceStations.map(s => s.noradId), [48274]);
    assert.equal(data.militarySatellites, 3);
    assert.deepEqual(data.militaryByCountry, { US: 1, CIS: 1, PRC: 1 });
    assert.deepEqual(data.constellations, { starlink: 7000, oneweb: 600 });
    assert.ok(data.signals.some(s => s.startsWith('NEW MILITARY OBJECTS: YAOGAN-43 01A')), data.signals.join(' | '));
  });

  it('reports degraded when one group fails and error when the core groups fail', async () => {
    const partial = await briefing({ loadGroup: stubCatalogue({ starlink: new Error('celestrak 503') }), fetchImpl: recentOk });
    assert.equal(partial.status, 'active');
    assert.match(partial.error, /starlink: celestrak 503/);
    assert.equal(partial.constellations.starlink, 0);

    clearRecentLaunchCache(); // otherwise the list cached above is (rightly) served
    const down = await briefing({ loadGroup: stubCatalogue({ stations: new Error('offline') }), fetchImpl: recentDown });
    assert.equal(down.status, 'error');
    assert.match(down.error, /recent launches: HTTP 503/);
  });

  it('caches the recent-launch list and serves it stale through a failed refresh', async () => {
    let calls = 0;
    const counting = async () => { calls += 1; return RECENT_OMM; };
    await briefing({ loadGroup: stubCatalogue(), fetchImpl: counting });
    await briefing({ loadGroup: stubCatalogue(), fetchImpl: counting });
    assert.equal(calls, 1, 'second sweep inside the TTL must not refetch');

    clearRecentLaunchCache();
    const first = await briefing({ loadGroup: stubCatalogue(), fetchImpl: recentDown });
    assert.equal(first.totalNewObjects, 0);
    assert.match(first.error, /recent launches: HTTP 503/);
    // Backoff: an immediate retry does not hit the network again.
    let retried = 0;
    const second = await briefing({ loadGroup: stubCatalogue(), fetchImpl: async () => { retried += 1; return RECENT_OMM; } });
    assert.equal(retried, 0);
    assert.match(second.error, /waiting out backoff/);
  });
});
