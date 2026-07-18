// AirWatch module — classification, region filter, backoff, baseline store.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify, hexCountry, inRegion, normalizeAircraft, countByCategory,
  backoffDelay, CATEGORIES, REGION,
} from '../services/airwatch/airwatchPoller.mjs';
import {
  initBaseline, recordSample, getBaseline, closeBaseline, hourKey,
} from '../services/airwatch/airwatchBaseline.mjs';

describe('airwatch classification', () => {
  test('classifies tankers by type designator', () => {
    assert.equal(classify('K35R'), 'TANKER');
    assert.equal(classify('K46'), 'TANKER');
    assert.equal(classify('DC10'), 'TANKER'); // KC-10 in a mil-only feed
    assert.equal(classify('A332'), 'TANKER'); // MRTT / Voyager in a mil-only feed
  });

  test('classifies ISR platforms', () => {
    for (const t of ['R135', 'E3TF', 'E8', 'P8', 'RQ4', 'MQ9', 'E2', 'U2']) {
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

describe('airwatch region + country', () => {
  test('bounding box matches the Middle East / Gulf theatre', () => {
    assert.equal(inRegion(26.5, 51.5), true);   // Persian Gulf
    assert.equal(inRegion(32, 35), true);       // eastern Med
    assert.equal(inRegion(51, 0), false);       // London
    assert.equal(inRegion(REGION.latMin, REGION.lonMin), true); // inclusive edges
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
  });

  test('drops records without a position, maps ground altitude to 0', () => {
    assert.equal(normalizeAircraft({ hex: 'ae01ce', t: 'C17' }), null);
    const grounded = normalizeAircraft({ hex: 'ae01ce', lat: 26, lon: 50, alt_baro: 'ground' });
    assert.equal(grounded.alt, 0);
  });

  test('countByCategory always includes every category', () => {
    const counts = countByCategory([{ cat: 'TANKER' }, { cat: 'TANKER' }, { cat: 'ISR' }]);
    assert.equal(counts.TANKER, 2);
    assert.equal(counts.ISR, 1);
    assert.equal(counts.FIGHTER, 0);
    assert.deepEqual(Object.keys(counts), CATEGORIES);
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
      if (String(url).includes('airplanes.live')) {
        return new Response('rate limited', { status: 429 });
      }
      return Response.json({
        ac: [
          { hex: 'ae01ce', flight: 'RCH285', t: 'C17', lat: 25.2, lon: 55.3, alt_baro: 32000, gs: 450, track: 90 },
          { hex: '43c6e1', flight: 'RRR2401', t: 'A332', lat: 35.0, lon: 33.0, alt_baro: 28000, gs: 430, track: 180 },
          { hex: 'ae0000', t: 'C130' }, // no position — must be excluded
        ],
        msg: 'No error',
      });
    };
    try {
      const ok = await startPoller();
      assert.equal(ok, true);
      const snapshot = getSnapshot();
      assert.equal(snapshot.source, 'adsb.lol');           // failover happened
      assert.equal(snapshot.aircraft.length, 2);           // positionless dropped
      assert.equal(snapshot.withoutPosition, 1);
      assert.equal(snapshot.regionAircraft.length, 2);     // both inside the bbox
      assert.equal(snapshot.regionAircraft[1].cat, 'TANKER');

      const status = getSourceStatus();
      assert.equal(status.active, 'adsb.lol');
      const primary = status.sources.find(s => s.id === 'airplanes.live');
      assert.ok(primary.rateLimitedForSeconds > 0);        // 429 cooldown armed
      assert.match(primary.lastError, /429/);
      assert.match(calls[0].ua, /Crucix-AirWatch/);        // descriptive User-Agent sent
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

      recordSample({ TANKER: 4, ISR: 2 });
      recordSample({ TANKER: 6, ISR: 2 });

      // Samples land in the CURRENT hour bucket, which the baseline excludes
      // by design (a half-full bucket would skew the average).
      const { perCategory, hours } = getBaseline();
      assert.equal(hours, 0);
      assert.equal(perCategory.TANKER, undefined);
    } finally {
      closeBaseline();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hourKey buckets by UTC hour', () => {
    assert.equal(hourKey(new Date('2026-07-18T14:59:59Z')), '2026-07-18T14');
    assert.equal(hourKey(new Date('2026-07-18T15:00:00Z')), '2026-07-18T15');
  });
});
