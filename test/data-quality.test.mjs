import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing as safecast } from '../apis/sources/safecast.mjs';
import { runSource } from '../apis/briefing.mjs';
import { buildSourceHealth, sourceCounts } from '../lib/source-health.mjs';
import { synthesize, generateIdeas } from '../dashboard/inject.mjs';
import { computeDelta } from '../lib/delta/engine.mjs';

const now = Date.parse('2026-09-05T03:00:00Z');
const recent = '2026-09-05T02:00:00Z';
const old = '2023-07-18T12:46:47Z';
const threeDaysAgo = '2026-09-02T03:00:00Z';
const options = { now, newsLoader: async () => [] };
const raw = sources => ({ crucix: { timestamp: recent }, sources, errors: [] });
const reading = (value, captured_at = recent, unit = 'cpm') => ({ value, captured_at, unit });

// Real-time feed fixtures: one device record per sensor, newest reading only.
const device = (over = {}) => ({
  device_urn: 'note:dev:1', device_sn: 'RR24016', loc_name: 'Slavutych', loc_country: 'UA',
  loc_lat: 51.52, loc_lon: 30.75, when_captured: recent, lnd_7318c: 30, ...over,
});
const feed = devices => Response.json(devices);

test('an empty Safecast device feed never produces an all-clear', async t => {
  t.mock.method(globalThis, 'fetch', async () => feed([]));
  const result = await safecast({ now });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.signals, []);
  assert.ok(result.sites.every(s => s.anomaly === null && s.avgCPM === null && s.status === 'no_coverage'));
});

test('Safecast rejects old observations and preserves their date', async t => {
  t.mock.method(globalThis, 'fetch', async () => feed([device({ when_captured: threeDaysAgo, lnd_7318c: 300 })]));
  const result = await safecast({ now });
  assert.equal(result.status, 'stale');
  assert.equal(result.lastObservationAt, threeDaysAgo);
  assert.deepEqual(result.signals, []);
  assert.ok(result.sites.every(s => s.recentReadings === 0 && s.anomaly === null));
  assert.equal(result.sites.find(s => s.key === 'chernobyl').status, 'stale');
});

test('a sensor silent for years is retired coverage, not a stale site', async t => {
  t.mock.method(globalThis, 'fetch', async () => feed([device({ when_captured: old, lnd_7318c: 300 })]));
  const result = await safecast({ now });
  assert.equal(result.sites.find(s => s.key === 'chernobyl').status, 'no_coverage');
  assert.equal(result.status, 'failed');
  assert.equal(result.lastObservationAt, null);
});

test('Safecast averages only fresh, positioned Geiger readings within a site radius', async t => {
  t.mock.method(globalThis, 'fetch', async () => feed([
    device({ lnd_7318c: 20 }),
    device({ device_urn: 'note:dev:2', loc_lat: 51.29, loc_lon: 29.9, lnd_7318c: 40, when_captured: '2026-09-05T01:00:00Z' }),
    device({ device_urn: 'note:dev:3', lnd_7318c: 900, when_captured: old }),          // stale, excluded from average
    device({ device_urn: 'note:dev:4', lnd_7318c: 800, when_captured: '2030-01-01T00:00:00Z' }), // future clock, dropped
    device({ device_urn: 'note:dev:5', lnd_7318c: 999, loc_lat: 0, loc_lon: 0 }),    // no position, dropped
    device({ device_urn: 'note:dev:6', lnd_7318c: undefined, pms_pm02_5: 12 }),      // air-only device, dropped
    device({ device_urn: 'note:dev:7', lnd_7318c: 50, loc_lat: 41.42, loc_lon: 2.17 }), // Barcelona: no site in range
  ]));
  const result = await safecast({ now });
  assert.equal(result.status, 'healthy');
  const chernobyl = result.sites.find(s => s.key === 'chernobyl');
  assert.equal(chernobyl.status, 'healthy');
  assert.equal(chernobyl.avgCPM, 30);
  assert.equal(chernobyl.recentReadings, 2);
  assert.equal(chernobyl.lastReading, recent);
  assert.equal(chernobyl.anomaly, false);
  assert.ok(result.sites.filter(s => s.key !== 'chernobyl').every(s => s.status === 'no_coverage'));
  assert.equal(result.signals.length, 1);
  assert.match(result.signals[0], /^Radiation normal at all 1 sites with sensor coverage \(no sensors: /);
});

test('Safecast flags an anomaly on the median dose rate, so tube sensitivity and hot in-zone sensors are respected', async t => {
  // 7318: 334 CPM/µSv/h → 150 CPM ≈ 0.45 µSv/h (anomaly). 712: 120 CPM/µSv/h → 30 CPM = 0.25 (normal).
  // One 900 CPM sensor at the Fukushima fence must not tip the site on its own.
  t.mock.method(globalThis, 'fetch', async () => feed([
    device({ lnd_7318c: 150 }),
    device({ device_urn: 'note:dev:jp2', loc_lat: 37.43, loc_lon: 141.02, loc_country: 'JP', lnd_7318c: 900 }),
    device({ device_urn: 'note:dev:jp3', loc_lat: 37.6, loc_lon: 140.9, loc_country: 'JP', lnd_7318c: 40 }),
    device({ device_urn: 'note:dev:jp', loc_lat: 37.5, loc_lon: 140.99, loc_country: 'JP', lnd_7318c: undefined, lnd_712u: 30 }),
  ]));
  const result = await safecast({ now });
  assert.equal(result.status, 'healthy');
  assert.equal(result.sites.find(s => s.key === 'chernobyl').anomaly, true);
  const fukushima = result.sites.find(s => s.key === 'fukushima');
  assert.equal(fukushima.anomaly, false);
  assert.equal(fukushima.recentReadings, 3);
  assert.equal(fukushima.maxCPM, 900);
  assert.equal(fukushima.avgCPM, 40);
  assert.equal(result.signals.length, 1);
  assert.match(result.signals[0], /^ELEVATED RADIATION at Chernobyl Exclusion Zone: 0\.45 µSv\/h/);
});

test('an upstream outage cannot produce normal radiation status', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Forbidden', { status: 403 }));
  const result = await safecast({ now });
  assert.equal(result.status, 'failed');
  assert.ok(result.sites.every(s => s.status === 'failed' && s.anomaly === null));
  assert.deepEqual(result.signals, []);
});

test('dashboard treats sites without sensors as declared gaps, not outages', async () => {
  const data = raw({
    Safecast: { status: 'healthy', sites: [
      { site: 'Chernobyl', key: 'chernobyl', status: 'healthy', recentReadings: 3, avgCPM: 31, anomaly: false, lastReading: recent },
      { site: 'Bushehr', key: 'bushehr', status: 'no_coverage', recentReadings: 0, avgCPM: null, anomaly: null, lastReading: null, error: 'No Safecast real-time sensors within 300 km' },
    ], signals: [] },
  });
  const result = await synthesize(data, options);
  assert.equal(result.nuke[1].status, 'no_coverage');
  assert.equal(result.nuke[1].anom, null);
  assert.equal(result.nuke[0].status, 'healthy');
  assert.match(result.nukeSignals[0], /^Radiation normal at all 1 sites with sensor coverage \(no sensors: Bushehr\)/);
  assert.equal(result.health.find(h => h.n === 'Safecast').status, 'healthy');
});

test('a radiation anomaly is reported in µSv/h, the unit it was decided in', async () => {
  const data = raw({
    Safecast: { status: 'healthy', sites: [
      { site: 'Zaporizhzhia', key: 'zaporizhzhia', status: 'healthy', recentReadings: 5, avgCPM: 150, avgUSvH: 0.45, anomaly: true, lastReading: recent },
    ], signals: [] },
  });
  const result = await synthesize(data, options);
  assert.equal(result.nuke[0].uSvH, 0.45);
  assert.equal(result.nukeSignals[0], 'ELEVATED RADIATION at Zaporizhzhia: 0.45 µSv/h median');
});

test('old cache hydration removes stale radiation alarms and does not count missing credentials as healthy', async () => {
  const data = raw({
    Safecast: { sites: [{ site: 'Chernobyl', recentReadings: 25, avgCPM: 124, anomaly: true, lastReading: old }], signals: ['ELEVATED RADIATION'] },
    ACLED: { status: 'no_credentials' }, Reddit: { status: 'no_key' },
    'Cloudflare-Radar': { status: 'no_credentials' },
    NOAA: { error: 'unavailable', totalSevereAlerts: null },
  });
  data.crucix.sourcesOk = 5; // legacy, incorrect cached health count
  const result = await synthesize(data, options);
  assert.equal(result.meta.sourcesOk, 0);
  assert.equal(result.meta.sourcesUnconfigured, 3);
  assert.equal(result.nuke[0].lastReading, old);
  assert.equal(result.nuke[0].status, 'stale');
  assert.equal(result.nuke[0].anom, null);
  assert.equal(result.nuke[0].cpm, null);
  assert.deepEqual(result.nukeSignals, []);
  assert.equal(result.noaa.totalAlerts, null);
  assert.equal(result.acled.totalEvents, null);
  assert.equal(result.treasury.totalDebt, null);
  assert.equal(result.epa.totalReadings, null);
});

test('valid empty NOAA and ACLED results stay zero', async () => {
  const result = await synthesize(raw({ NOAA: { totalSevereAlerts: 0 }, ACLED: { totalEvents: 0, totalFatalities: 0 } }), options);
  assert.equal(result.noaa.totalAlerts, 0);
  assert.equal(result.acled.totalEvents, 0);
});

test('runSource distinguishes every canonical state and thrown failures', async () => {
  for (const [payload, expected] of [
    [{ status: 'no_key' }, 'unconfigured'], [{ status: 'no_credentials' }, 'unconfigured'],
    [{ stale: true, error: 'using old data' }, 'stale'], [{ error: 'partial outage' }, 'degraded'],
    [{ status: 'error', error: 'offline' }, 'failed'], [{ readings: [] }, 'healthy'], [null, 'failed'],
  ]) {
    assert.equal((await runSource('test', async () => payload)).status, expected);
  }
  assert.equal((await runSource('test', async () => { throw new Error('offline'); })).status, 'failed');
});

test('source coverage retains last success across outages and gives source-specific recovery guidance', () => {
  const previous = buildSourceHealth({ EPA: { timestamp: old } });
  const health = buildSourceHealth({ Reddit: { status: 'no_key', message: 'Needs OAuth' } }, [{ name: 'EPA', error: 'HTTP 403' }], previous, recent);
  assert.equal(health.find(h => h.n === 'EPA').lastSuccessAt, old);
  assert.equal(health.find(h => h.n === 'EPA').checkedAt, recent);
  assert.match(health.find(h => h.n === 'Reddit').recovery, /REDDIT_CLIENT_ID/);
  assert.match(health.find(h => h.n === 'EPA').recovery, /EPA/);
  assert.equal(sourceCounts(health).sourcesOk, 0);
  assert.equal(sourceCounts(health).sourcesUnconfigured, 1);
  assert.equal(sourceCounts(health).sourcesUnavailable, 1);
});

test('Yahoo and EIA histories produce the same rising/falling oil ideas regardless of input ordering', async () => {
  for (const [values, title, movement] of [
    [[85.76, 90.22, 91.22], 'Oil Momentum Building', '+6.4%'],
    [[100, 95, 90], 'Oil Under Pressure', '-10.0%'],
  ]) {
    const rows = values.map((value, i) => ({ date: `2026-09-0${i+1}`, value }));
    for (const sources of [
      { EIA: { oilPrices: { wti: { value: values.at(-1), recent: rows.toReversed() } } } },
      { YFinance: { quotes: { 'CL=F': { price: values.at(-1), history: rows.map(r => ({ date: r.date, close: r.value })) } } } },
    ]) {
      const result = await synthesize(raw(sources), options);
      assert.deepEqual(result.energy.wtiRecent, values);
      const idea = generateIdeas(result).find(i => i.title === title);
      assert.ok(idea, `missing ${title}`);
      assert.ok(idea.text.includes(movement), idea.text);
    }
  }
});

test('losing coverage cannot resolve a nuclear anomaly or imply conflict de-escalation', () => {
  const previous = { meta: {}, nuke: [{ site: 'A', status: 'healthy', anom: true }], acled: { totalEvents: 40, totalFatalities: 20 }, health: [{ n: 'ACLED', status: 'healthy', err: false }] };
  const current = { meta: {}, nuke: [{ site: 'A', status: 'stale', anom: null }], acled: { totalEvents: null, totalFatalities: null }, health: [{ n: 'ACLED', status: 'failed', err: true }] };
  const delta = computeDelta(current, previous);
  assert.ok(!delta.signals.deescalated.some(s => ['nuke_anomaly','conflict_events','conflict_fatalities'].includes(s.key)));
  current.nuke = [{ site: 'A', status: 'healthy', anom: false }];
  assert.ok(computeDelta(current, previous).signals.deescalated.some(s => s.key === 'nuke_anomaly'));
});
