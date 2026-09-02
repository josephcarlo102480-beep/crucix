// AirWatch module — classification, theatre filters, backoff, baseline store.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify, hexCountry, inRegion, normalizeAircraft, countByCategory,
  backoffDelay, missionFor, isUsMilHex, buildSample, getSnapshot, getSourceStatus,
  CATEGORIES, REGION, THEATRES, THEATRE_IDS, DEFAULT_THEATRE,
} from '../services/airwatch/airwatchPoller.mjs';
import {
  initBaseline, recordSample, getBaseline, closeBaseline, hourKey,
} from '../services/airwatch/airwatchBaseline.mjs';
import airwatchRouter from '../services/airwatch/airwatchRouter.mjs';

describe('airwatch classification', () => {
  test('classifies tankers by type designator', () => {
    assert.equal(classify('K35R'), 'TANKER');
    assert.equal(classify('K46'), 'TANKER');
    assert.equal(classify('DC10'), 'TANKER'); // KC-10 in a mil-only feed
    assert.equal(classify('A332'), 'TANKER'); // MRTT / Voyager in a mil-only feed
  });

  test('maritime patrol is its own category, not lumped into ISR', () => {
    for (const t of ['P8', 'P3', 'P1', 'ATLA', 'S3', 'MQ4C']) {
      assert.equal(classify(t), 'ASW', t);
    }
  });

  test('classifies ISR platforms', () => {
    for (const t of ['R135', 'E3TF', 'E8', 'RQ4', 'MQ9', 'E2', 'U2', 'E6']) {
      assert.equal(classify(t), 'ISR', t);
    }
  });

  test('classifies heavy lift', () => {
    for (const t of ['C17', 'C5M', 'A400', 'C130', 'C30J']) {
      assert.equal(classify(t), 'HEAVY', t);
    }
  });

  test('classifies fighters via prefixes', () => {
    for (const t of ['F16', 'F15E', 'F35A', 'EUFI', 'RFAL']) {
      assert.equal(classify(t), 'FIGHTER', t);
    }
  });

  test('emitter category A7 is the helicopter catch-all', () => {
    assert.equal(classify('', 'A7'), 'HELO');
    assert.equal(classify('H60'), 'HELO');
  });

  test('unknown types fall through to OTHER without matching E3-like civilian codes', () => {
    assert.equal(classify('ZZZZ'), 'OTHER');
    assert.equal(classify(null), 'OTHER');
    assert.equal(classify('E35L'), 'OTHER'); // Embraer Legacy 600, NOT an E-3
  });
});

describe('airwatch recon watch', () => {
  test('describes the mission of watched platforms', () => {
    assert.match(missionFor('P8'), /Poseidon/);
    assert.match(missionFor('P8'), /submarine/i);
    assert.match(missionFor('R135'), /Rivet Joint/);
    assert.match(missionFor('E6'), /TACAMO/);
    assert.equal(missionFor('C17'), null);   // transport is not recon
    assert.equal(missionFor(''), null);
    assert.equal(missionFor(null), null);
  });

  test('contractor ISR jets only count on a US military hex', () => {
    // CL60/GLEX are common VIP types — the type alone proves nothing.
    assert.equal(missionFor('GLEX', false), null);
    assert.match(missionFor('GLEX', true), /contractor ISR/);
    assert.equal(missionFor('CL60', false), null);
    assert.match(missionFor('CL60', true), /ARTEMIS/);
  });

  test('US military hex block starts inside ADF7xx, not at AE0000', () => {
    assert.equal(isUsMilHex('ae01ce'), true);
    assert.equal(isUsMilHex('adf999'), true);   // below AE0000 but still US mil
    assert.equal(isUsMilHex('adf000'), false);  // below the block
    assert.equal(isUsMilHex('43c6e1'), false);  // UK
    assert.equal(isUsMilHex('nothex'), false);
  });

  test('flags recon aircraft during normalization', () => {
    const p8 = normalizeAircraft({ hex: 'ae682f', t: 'P8', lat: 35, lon: -74, alt_baro: 28000 });
    assert.equal(p8.cat, 'ASW');
    assert.equal(p8.recon, true);
    assert.equal(p8.usMil, true);
    assert.match(p8.mission, /submarine/i);

    const c17 = normalizeAircraft({ hex: 'ae01ce', t: 'C17', lat: 35, lon: -74, alt_baro: 28000 });
    assert.equal(c17.recon, false);
    assert.equal(c17.mission, null);
  });
});

describe('airwatch theatres + country', () => {
  test('every theatre has a usable box and map view', () => {
    for (const id of THEATRE_IDS) {
      const t = THEATRES[id];
      assert.ok(t.latMin < t.latMax, id);
      assert.ok(t.lonMin < t.lonMax, id);
      assert.equal(t.center.length, 2, id);
      assert.ok(t.label, id);
    }
    assert.ok(THEATRE_IDS.includes(DEFAULT_THEATRE));
  });

  test('bounding boxes match their theatres', () => {
    assert.equal(inRegion(36, -71, 'usEast'), true);        // western Atlantic
    assert.equal(inRegion(30.3, -81.6, 'usEast'), true);    // NAS Jacksonville
    assert.equal(inRegion(26.5, 51.5, 'usEast'), false);    // Persian Gulf is elsewhere
    assert.equal(inRegion(26.5, 51.5, 'midEast'), true);
    assert.equal(inRegion(32, 35, 'midEast'), true);        // eastern Med
    assert.equal(inRegion(51, 0, 'midEast'), false);        // London
    assert.equal(inRegion(51, 0, 'europe'), true);
    assert.equal(inRegion(24, 121, 'indoPac'), true);       // Taiwan Strait
  });

  test('defaults to the US east coast theatre and honors inclusive edges', () => {
    assert.equal(DEFAULT_THEATRE, 'usEast');
    assert.equal(inRegion(36, -71), true);
    assert.equal(inRegion(REGION.latMin, REGION.lonMin), true);
    assert.equal(inRegion(REGION.latMax, REGION.lonMax), true);
  });

  test('unknown theatre names fall back to the default box', () => {
    assert.equal(inRegion(36, -71, 'nope'), true);
    assert.equal(inRegion(26.5, 51.5, 'nope'), false);
  });

  test('hexCountry resolves known ICAO allocations', () => {
    assert.equal(hexCountry('AE01CE'), 'United States');
    assert.equal(hexCountry('43C6E1'), 'United Kingdom');
    assert.equal(hexCountry('738A00'), 'Israel');
    assert.equal(hexCountry('730123'), 'Iran');
    assert.equal(hexCountry('nothex'), null);
    assert.equal(hexCountry(''), null);
  });
});

describe('airwatch normalization', () => {
  test('normalizes a raw feed record', () => {
    const ac = normalizeAircraft({
      hex: 'ae01ce', flight: 'RCH285  ', t: 'C17', desc: 'BOEING C-17A',
      lat: 25.2, lon: 55.3, alt_baro: 32000, gs: 450.2, track: 91.4,
      squawk: '3701', r: '07-7189', category: 'A5', seen_pos: 1.2,
    });
    assert.equal(ac.hex, 'ae01ce');
    assert.equal(ac.callsign, 'RCH285');
    assert.equal(ac.cat, 'HEAVY');
    assert.equal(ac.alt, 32000);
    assert.equal(ac.country, 'United States');
    assert.equal(ac.posSource, 'adsb');
    assert.equal(ac.onGround, false);
  });

  test('marks how a position was derived instead of trusting them equally', () => {
    // MLAT: triangulated by receivers, not broadcast by the aircraft.
    const mlat = normalizeAircraft({
      hex: 'af3d06', t: 'E6', lat: 34.05, lon: -112.9, alt_baro: 27000,
      mlat: ['gs', 'track', 'lat', 'lon'],
    });
    assert.equal(mlat.posSource, 'mlat');

    // No live position, but a stale fix is still on record.
    const stale = normalizeAircraft({
      hex: 'ae11e3', t: 'E3TF', alt_baro: 33000,
      lastPosition: { lat: 42.66, lon: -112.02, seen_pos: 1525 },
    });
    assert.equal(stale.posSource, 'last');
    assert.equal(stale.lat, 42.66);

    // Only a receiver-area guess.
    const approx = normalizeAircraft({ hex: 'ae11e3', t: 'E3TF', rr_lat: 40.5, rr_lon: -108.5 });
    assert.equal(approx.posSource, 'approx');
    assert.equal(approx.lat, 40.5);
  });

  test('drops records with no position at all, maps ground altitude to 0', () => {
    assert.equal(normalizeAircraft({ hex: 'ae01ce', t: 'C17' }), null);
    const grounded = normalizeAircraft({ hex: 'ae01ce', lat: 26, lon: 50, alt_baro: 'ground' });
    assert.equal(grounded.alt, 0);
    assert.equal(grounded.onGround, true);
  });

  test('drops ground transponder test rigs', () => {
    assert.equal(normalizeAircraft({ hex: 'adf991', t: 'TWR', lat: 30, lon: -80 }), null);
    assert.equal(normalizeAircraft({ hex: 'adf991', flight: 'TEST1234', lat: 30, lon: -80 }), null);
  });

  test('countByCategory always includes every category', () => {
    const counts = countByCategory([{ cat: 'TANKER' }, { cat: 'TANKER' }, { cat: 'ASW' }]);
    assert.equal(counts.TANKER, 2);
    assert.equal(counts.ASW, 1);
    assert.equal(counts.FIGHTER, 0);
    assert.deepEqual(Object.keys(counts), CATEGORIES);
  });

  test('buildSample keys baseline rows per theatre', () => {
    const sample = buildSample({ usEast: [{ cat: 'ASW' }], midEast: [] });
    assert.equal(sample['usEast:ASW'], 1);
    assert.equal(sample['usEast:TANKER'], 0);
    assert.equal(sample['midEast:ASW'], 0);
  });
});

describe('airwatch backoff', () => {
  test('doubles per failure and caps at 5 minutes', () => {
    assert.equal(backoffDelay(0, 45_000), 45_000);
    assert.equal(backoffDelay(1, 45_000), 90_000);
    assert.equal(backoffDelay(2, 45_000), 180_000);
    assert.equal(backoffDelay(3, 45_000), 300_000); // capped
    assert.equal(backoffDelay(10, 45_000), 300_000);
  });
});

describe('airwatch poller failover (stubbed fetch)', () => {
  test('rate-limited primary fails over to adsb.lol and populates the cache', async () => {
    const { startPoller, stopPoller, getSnapshot, getSourceStatus } =
      await import('../services/airwatch/airwatchPoller.mjs');
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), ua: opts?.headers?.['User-Agent'] });
      if (String(url).includes('adsb.fi')) {
        return new Response('rate limited', { status: 429 });
      }
      return Response.json({
        ac: [
          { hex: 'ae01ce', flight: 'RCH285', t: 'C17', lat: 36.2, lon: -71.5, alt_baro: 32000, gs: 450, track: 90 },
          { hex: 'ae682f', t: 'P8', lat: 35.0, lon: -74.0, alt_baro: 28000, gs: 400, mlat: ['lat', 'lon'] },
          { hex: '43c6e1', flight: 'RRR2401', t: 'A332', lat: 35.0, lon: 33.0, alt_baro: 28000, gs: 430, track: 180 },
          { hex: 'ae0000', t: 'C130' },                                  // no position — excluded
          { hex: 'adf991', t: 'C17', lat: 36, lon: -76, alt_baro: 'ground' }, // parked — excluded
        ],
        msg: 'No error',
      });
    };
    try {
      const ok = await startPoller();
      assert.equal(ok, true);
      const snapshot = getSnapshot();
      assert.equal(snapshot.source, 'adsb.lol');            // failover happened
      assert.equal(snapshot.aircraft.length, 3);            // positionless + parked dropped
      assert.equal(snapshot.withoutPosition, 1);
      assert.equal(snapshot.onGround, 1);
      assert.equal(snapshot.byTheatre.usEast.length, 2);    // C-17 + P-8 off the coast
      assert.equal(snapshot.byTheatre.midEast.length, 1);   // the Voyager over Cyprus
      const p8 = snapshot.byTheatre.usEast.find(ac => ac.type === 'P8');
      assert.equal(p8.cat, 'ASW');
      assert.equal(p8.recon, true);
      assert.equal(p8.posSource, 'mlat');

      const status = getSourceStatus();
      assert.equal(status.active, 'adsb.lol');
      const primary = status.sources.find(s => s.id === 'adsb.fi');
      assert.ok(primary.rateLimitedForSeconds > 0);         // 429 cooldown armed
      assert.match(primary.lastError, /429/);
      assert.match(calls[0].ua, /Crucix-AirWatch/);         // descriptive User-Agent sent
    } finally {
      stopPoller();
      globalThis.fetch = realFetch;
    }
  });
});

describe('airwatch baseline store', () => {
  test('records samples and excludes the in-progress hour from the baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airwatch-test-'));
    try {
      const backend = await initBaseline(join(dir, 'airwatch.sqlite'));
      assert.ok(['sqlite', 'json'].includes(backend));

      recordSample({ 'usEast:TANKER': 4, 'usEast:ASW': 2 });
      recordSample({ 'usEast:TANKER': 6, 'usEast:ASW': 2 });

      // Samples land in the CURRENT hour bucket, which the baseline excludes
      // by design (a half-full bucket would skew the average).
      const { perCategory, hours } = getBaseline();
      assert.equal(hours, 0);
      assert.equal(perCategory['usEast:TANKER'], undefined);
    } finally {
      closeBaseline();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hourKey buckets by UTC hour', () => {
    assert.equal(hourKey(new Date('2026-07-18T14:59:59Z')), '2026-07-18T14');
    assert.equal(hourKey(new Date('2026-07-18T15:00:00Z')), '2026-07-18T15');
  });

  test('rethrows and logs sqlite initialization errors instead of silently using JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airwatch-sqlite-error-'));
    const realError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      await assert.rejects(initBaseline(dir));
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /SQLite baseline initialization failed/);
      assert.ok(logged[0][1] instanceof Error);
    } finally {
      console.error = realError;
      closeBaseline();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('airwatch router freshness', () => {
  test('marks data stale at twice the configured poll interval plus 30 seconds', async () => {
    const snapshot = getSnapshot();
    assert.ok(snapshot, 'the stubbed failover poll should have populated a snapshot');
    const threshold = 2 * getSourceStatus().pollSeconds + 30;
    snapshot.fetchedAt = new Date(Date.now() - (threshold + 2) * 1000).toISOString();

    const layer = airwatchRouter.stack.find((item) => item.route?.path === '/aircraft');
    const response = { headers: {} };
    response.set = (key, value) => { response.headers[key] = value; return response; };
    response.status = (code) => { response.statusCode = code; return response; };
    response.json = (body) => { response.body = body; return response; };
    layer.route.stack[0].handle({ query: {} }, response);
    assert.equal(response.body.ageSeconds, threshold + 2);
    assert.equal(response.body.stale, true);
  });
});
