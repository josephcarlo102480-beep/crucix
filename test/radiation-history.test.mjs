import test from 'node:test';
import assert from 'node:assert/strict';
import { openStationHistory, findRisingStations, BASELINE_MIN_SAMPLES } from '../lib/radiation-history.mjs';
import { briefing } from '../apis/sources/radiation-eu.mjs';

const HOUR = 3600_000;
const now = Date.parse('2026-09-23T12:30:00Z');
const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
const station = (id, uSvH, hoursAgo = 0, extra = {}) => ({
  network: 'BfS', id, name: id, lat: 50, lon: 10, uSvH, observedAt: at(hoursAgo), ...extra,
});

async function seededHistory(readings) {
  const history = await openStationHistory(':memory:');
  for (let h = 24; h >= 1; h--) history.record(readings.map(([id, v]) => station(id, v, h)), now - h * HOUR);
  return history;
}

test('a probe is flagged only when it doubles AND rises by at least 0.1 µSv/h over its own median', async () => {
  const history = await seededHistory([['LOW', 0.07], ['GRANITE', 0.25], ['RAIN', 0.1]]);
  const current = [
    station('LOW', 0.3),       // 4.3x and +0.23 — a real local rise
    station('GRANITE', 0.3),   // high but normal for this site
    station('RAIN', 0.16),     // +60%: typical washout, not flagged
  ];
  const baselines = history.baselines(current, now);
  assert.equal(baselines.get('LOW').samples, 24);
  const rising = findRisingStations(current, baselines);
  assert.deepEqual(rising.map(r => r.station.id), ['LOW']);
  assert.equal(rising[0].baselineUSvH, 0.07);
  history.close();
});

test('no baseline until enough hours are stored, and the current hour never counts toward it', async () => {
  const history = await openStationHistory(':memory:');
  for (let h = BASELINE_MIN_SAMPLES - 1; h >= 1; h--) history.record([station('NEW', 0.08, h)], now - h * HOUR);
  assert.equal(history.baselines([station('NEW', 0.5)], now).size, 0);

  history.record([station('NEW', 0.5)], now); // current hour stored...
  history.record([station('NEW', 0.08, BASELINE_MIN_SAMPLES)], now);
  const base = history.baselines([station('NEW', 0.5)], now).get('NEW');
  assert.equal(base.samples, BASELINE_MIN_SAMPLES); // ...but excluded from its own baseline
  assert.equal(base.medianUSvH, 0.08);
  history.close();
});

test('re-recording the same hour does not duplicate samples', async () => {
  const history = await seededHistory([['A', 0.1]]);
  history.record([station('A', 0.9, 3)], now); // same hour as an existing row
  assert.equal(history.baselines([station('A', 0.1)], now).get('A').samples, 24);
  history.close();
});

test('briefing reports rising stations and keeps them on the thinned map', async t => {
  const history = await openStationHistory(':memory:');
  for (let h = 24; h >= 1; h--) {
    history.record([
      station('HOT', 0.07, h, { lat: 50.1, lon: 10.1 }),
      station('NEIGHBOUR', 0.2, h, { lat: 50.2, lon: 10.2 }),
    ], now - h * HOUR);
  }
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).startsWith('https://www.imis.bfs.de/')) {
      const feature = (id, lat, lon, value) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { id, name: id, site_status: 1, end_measure: at(0), value },
      });
      // Same 0.5° cell: NEIGHBOUR reads higher, but HOT is the one that moved.
      return Response.json({ type: 'FeatureCollection', features: [feature('HOT', 50.1, 10.1, 0.31), feature('NEIGHBOUR', 50.2, 10.2, 0.35)] });
    }
    return new Response('<wfs:FeatureCollection></wfs:FeatureCollection>');
  });
  const result = await briefing({ now, history });
  assert.equal(result.risingCount, 1);
  assert.equal(result.rising[0].name, 'HOT');
  assert.equal(result.rising[0].baselineUSvH, 0.07);
  assert.match(result.signals.join('\n'), /1 European station at ≥2× its own 72h median \(largest: HOT 0\.31 vs 0\.07 µSv\/h\)/);
  const mapped = result.stations.find(s => s.name === 'HOT');
  assert.equal(mapped?.rising, true);
  assert.equal(result.stations.some(s => s.name === 'NEIGHBOUR'), false);
  history.close();
});

test('without a history store the comparison is simply off', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'FeatureCollection', features: [] }));
  const result = await briefing({ now });
  assert.equal(result.risingCount, null);
  assert.deepEqual(result.rising, []);
});
