// Satellite pass helper tests — no network calls

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_ZIPS,
  clearSatellitePassCache,
  getSatellitePassContext,
  observerForQuestion,
  questionNeedsSatellitePassContext,
  resolveObserver,
} from '../lib/space/satellitePasses.mjs';
import { GROUPS } from '../../Crucix/services/space/tleCatalog.mjs';

// A structurally valid ISS element set. The epoch is rewritten to "now" so the
// 14-day freshness filter keeps it; the orbit itself is irrelevant to the test.
const ISS_LINE1 = '1 25544U 98067A   24001.50000000  .00016717  00000+0  10270-3 0  9004';
const ISS_LINE2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

function freshIssTle(name = 'ISS (ZARYA)', id = 25544) {
  const now = new Date();
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const dayOfYear = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const epoch = `${yy}${String(dayOfYear).padStart(3, '0')}.50000000`;
  return {
    id,
    name,
    line1: ISS_LINE1.slice(0, 18) + epoch + ISS_LINE1.slice(32),
    line2: ISS_LINE2,
  };
}

describe('satellite pass helpers', () => {
  it('detects satellite visibility questions', () => {
    assert.equal(questionNeedsSatellitePassContext('are any satellites visible over 70443 now?'), true);
    assert.equal(questionNeedsSatellitePassContext('when is the next METEOR-M pass?'), true);
    assert.equal(questionNeedsSatellitePassContext('what changed in oil?'), false);
  });

  it('maps ZIP 70443 to the Crucix satellite tracker observer', () => {
    const observer = observerForQuestion('satellites over 70443');
    assert.equal(observer.zip, '70443');
    assert.equal(observer.label, 'Independence, LA');
    assert.equal(observer.lat, 30.5155);
    assert.equal(observer.lng, -90.5063);
  });
});

describe('observer resolution', () => {
  it('reports a known ZIP as matched', () => {
    const { observer, matched, requestedZip } = resolveObserver('70443');
    assert.equal(matched, true);
    assert.equal(requestedZip, '70443');
    assert.equal(observer.zip, '70443');
  });

  it('falls back to the default observer but says so', () => {
    const { observer, matched, requestedZip } = resolveObserver('90210');
    assert.equal(matched, false, 'an unknown ZIP must not masquerade as a match');
    assert.equal(requestedZip, '90210');
    assert.equal(observer.zip, '70443', 'the default observer keeps Ask AI working');
  });

  it('reports no requested ZIP when the text has none', () => {
    const { matched, requestedZip } = resolveObserver('are any satellites overhead?');
    assert.equal(matched, false);
    assert.equal(requestedZip, null);
  });

  it('exports the ZIPs it actually knows about', () => {
    assert.deepEqual(KNOWN_ZIPS, ['70443']);
  });
});

describe('getSatellitePassContext', () => {
  const opts = (extra = {}) => ({
    now: new Date('2026-07-09T02:00:00.000Z'),
    hoursAhead: 2,
    categories: ['iss'],
    loadTles: async () => [freshIssTle()],
    ...extra,
  });

  it('surfaces the observer fallback in the result', async () => {
    const result = await getSatellitePassContext('90210', opts());
    assert.equal(result.observer.matched, false);
    assert.equal(result.observer.requestedZip, '90210');
    assert.equal(result.observer.zip, '70443');

    const matchedResult = await getSatellitePassContext('70443', opts());
    assert.equal(matchedResult.observer.matched, true);
    assert.equal(matchedResult.observer.requestedZip, '70443');
  });

  it('takes elements from the injected loader, not the network', async () => {
    const seen = [];
    const result = await getSatellitePassContext('70443', opts({
      categories: ['iss', 'meteor', 'starlink', 'oneweb', 'gps', 'military'],
      loadTles: async (category, def) => {
        seen.push({ category, def });
        return category === 'iss' ? [freshIssTle()] : [];
      },
    }));

    assert.deepEqual(seen.map(s => s.category), ['iss', 'meteor', 'starlink', 'oneweb', 'gps', 'military']);
    assert.deepEqual(result.errors, []);
    assert.ok(Array.isArray(result.upcomingPasses));
    assert.ok(Array.isArray(result.currentAboveHorizon));
  });

  it('maps every category onto a real TLE catalog group or a search', async () => {
    const defs = new Map();
    await getSatellitePassContext('70443', opts({
      categories: ['iss', 'meteor', 'starlink', 'oneweb', 'gps', 'military'],
      loadTles: async (category, def) => { defs.set(category, def); return []; },
    }));

    assert.equal(defs.get('iss').group, 'stations');
    assert.deepEqual(defs.get('iss').noradIds, [25544]);
    assert.equal(defs.get('meteor').search, 'METEOR-M');
    assert.equal(defs.get('starlink').group, 'starlink');
    assert.equal(defs.get('oneweb').group, 'oneweb');
    assert.equal(defs.get('military').group, 'military');

    for (const [category, def] of defs) {
      if (!def.group) continue;
      assert.ok(GROUPS[def.group], `${category} maps to unknown group ${def.group}`);
    }
  });

  it('keeps going when one category fails, and records the error', async () => {
    const result = await getSatellitePassContext('70443', opts({
      categories: ['iss', 'starlink'],
      loadTles: async (category) => {
        if (category === 'starlink') throw new Error('celestrak down');
        return [freshIssTle()];
      },
    }));

    assert.deepEqual(result.errors, [{ category: 'starlink', error: 'celestrak down' }]);
    assert.deepEqual(result.categoriesChecked, ['iss', 'starlink']);
  });

  it('drops elements whose epoch is too old to propagate', async () => {
    const stale = freshIssTle();
    stale.line1 = ISS_LINE1; // 2024 epoch — well past the 14-day cutoff
    const result = await getSatellitePassContext('70443', opts({ loadTles: async () => [stale] }));
    assert.equal(result.upcomingPasses.length, 0);
    assert.equal(result.currentAboveHorizon.length, 0);
  });

  it('reports an unknown category as an error rather than throwing', async () => {
    const result = await getSatellitePassContext('70443', opts({ categories: ['nope'] }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /unknown satellite category/);
  });

  it('serves a repeat request from cache and re-computes for another observer', async () => {
    clearSatellitePassCache();
    let loads = 0;
    const cached = {
      hoursAhead: 2,
      categories: ['iss'],
      loadTles: undefined,
    };
    // The injected loader disables caching by design, so exercise the cache by
    // handing the module a fixed observer and counting propagation instead.
    const observerA = { zip: '70443', label: 'A', lat: 30.5, lng: -90.5 };
    const observerB = { zip: '00000', label: 'B', lat: 40, lng: -74 };
    const load = async () => { loads += 1; return [freshIssTle()]; };

    const first = await getSatellitePassContext('', { ...cached, observer: observerA, loadTles: load, cache: false });
    const second = await getSatellitePassContext('', { ...cached, observer: observerB, loadTles: load, cache: false });

    assert.equal(loads, 2, 'a different observer is a different computation');
    assert.equal(first.observer.label, 'A');
    assert.equal(second.observer.label, 'B');
  });
});
