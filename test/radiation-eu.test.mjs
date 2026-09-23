import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing, parseBfs, parseStuk, thinStations, BFS_URL, STUK_URL } from '../apis/sources/radiation-eu.mjs';
import { synthesize } from '../dashboard/inject.mjs';

const now = Date.parse('2026-09-13T01:00:00Z');
const recent = '2026-09-13T00:00:00Z';
const old = '2026-09-01T00:00:00Z';

const bfsFeature = (over = {}, props = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [over.lon ?? 10.84, over.lat ?? 50.18] },
  properties: { id: over.id || 'DEZ2995', name: over.name || 'Seßlach', site_status: 1, end_measure: over.observedAt || recent, value: over.value ?? 0.14, unit: 'µSv/h', validated: 1, ...props },
});
const bfsPayload = (features) => ({ type: 'FeatureCollection', features });
const stukElement = (lat, lon, value, time = recent, param = 'DR_PT10M_avg') => `
  <wfs:member><BsWfs:BsWfsElement gml:id="x"><BsWfs:Location><gml:Point><gml:pos>${lat} ${lon} </gml:pos></gml:Point></BsWfs:Location>
  <BsWfs:Time>${time}</BsWfs:Time><BsWfs:ParameterName>${param}</BsWfs:ParameterName><BsWfs:ParameterValue>${value}</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>`;
const stukPayload = (...elements) => `<?xml version="1.0"?><wfs:FeatureCollection>${elements.join('')}</wfs:FeatureCollection>`;

function mockFeeds(t, { bfs, stuk }) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    if (String(url).startsWith('https://www.imis.bfs.de/')) return typeof bfs === 'function' ? bfs() : Response.json(bfs);
    if (String(url).startsWith('https://opendata.fmi.fi/')) return typeof stuk === 'function' ? stuk() : new Response(stuk, { headers: { 'content-type': 'text/xml' } });
    throw new Error(`unexpected URL ${url}`);
  });
  return urls;
}

test('parsers keep only in-service, positioned, dated dose-rate readings', () => {
  const bfs = parseBfs(bfsPayload([
    bfsFeature(),
    bfsFeature({ id: 'OFF' }, { site_status: 2 }),                       // out of service
    bfsFeature({ id: 'NOVAL' }, { value: null }),                          // no reading
    bfsFeature({ id: 'FUTURE', observedAt: '2030-01-01T00:00:00Z' }),     // clock ahead
  ]), now);
  assert.deepEqual(bfs.map(s => s.id), ['DEZ2995']);
  assert.equal(bfs[0].network, 'BfS');
  assert.equal(bfs[0].lat, 50.18);
  assert.equal(bfs[0].uSvH, 0.14);

  const stuk = parseStuk(stukPayload(
    stukElement(60.2229, 25.1788, 0.111),
    stukElement(60.2229, 25.1788, 0.013, recent, 'DRS1_PT10M_avg'),     // other channel, skipped
    stukElement(61, 25, 'NaN'),
  ), now);
  assert.equal(stuk.length, 1);
  assert.equal(stuk[0].network, 'STUK');
  assert.equal(stuk[0].uSvH, 0.111);
  assert.equal(stuk[0].observedAt, recent);
  assert.equal(parseStuk('<html>maintenance</html>'), null);
  assert.equal(parseBfs({ error: 'HTTP 500' }), null);
});

test('thinning keeps the highest reading per grid cell', () => {
  const thinned = thinStations([
    { lat: 50.1, lon: 10.1, uSvH: 0.1 }, { lat: 50.2, lon: 10.2, uSvH: 0.3 }, { lat: 52.6, lon: 10.1, uSvH: 0.05 },
  ]);
  assert.deepEqual(thinned.map(s => s.uSvH).sort(), [0.05, 0.3]);
});

test('both networks healthy yields a normal background signal and thinned map stations', async t => {
  const urls = mockFeeds(t, {
    bfs: bfsPayload([bfsFeature(), bfsFeature({ id: 'B2', lat: 48.1, lon: 11.5, value: 0.09 })]),
    stuk: stukPayload(stukElement(60.2229, 25.1788, 0.111), stukElement(64.9, 25.7, 0.13)),
  });
  const result = await briefing({ now });
  assert.deepEqual(urls.sort(), [BFS_URL, STUK_URL].sort());
  assert.equal(result.status, 'healthy');
  assert.equal(result.stationsFresh, 4);
  assert.equal(result.medianUSvH, 0.12);
  assert.equal(result.anomaly, false);
  assert.deepEqual(result.elevated, []);
  assert.equal(result.stations.length, 4);
  assert.equal(result.networks.find(n => n.network === 'BfS').maxStation.name, 'Seßlach');
  assert.match(result.signals[0], /^European background normal: median 0\.12 µSv\/h across 4 state monitors \(BfS \+ STUK\)/);
});

test('one network down is degraded, not failed, and the other still reports', async t => {
  mockFeeds(t, { bfs: bfsPayload([bfsFeature()]), stuk: () => new Response('Service Unavailable', { status: 503 }) });
  const result = await briefing({ now });
  assert.equal(result.status, 'degraded');
  assert.equal(result.networks.find(n => n.network === 'STUK').status, 'failed');
  assert.equal(result.networks.find(n => n.network === 'BfS').status, 'healthy');
  assert.match(result.error, /^STUK unavailable/);
  assert.equal(result.medianUSvH, 0.14);
});

test('both networks down is failed with no median and no signal', async t => {
  mockFeeds(t, { bfs: () => new Response('nope', { status: 403 }), stuk: () => new Response('nope', { status: 403 }) });
  const result = await briefing({ now });
  assert.equal(result.status, 'failed');
  assert.equal(result.medianUSvH, null);
  assert.equal(result.anomaly, null);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(result.stations, []);
});

test('old observations are stale and never averaged', async t => {
  mockFeeds(t, { bfs: bfsPayload([bfsFeature({ observedAt: old, value: 5 })]), stuk: stukPayload(stukElement(60, 25, 5, old)) });
  const result = await briefing({ now });
  assert.equal(result.status, 'stale');
  assert.equal(result.lastObservationAt, old);
  assert.equal(result.medianUSvH, null);
  assert.deepEqual(result.signals, []);
});

test('a single hot probe is named as elevated while the network median stays normal', async t => {
  mockFeeds(t, {
    bfs: bfsPayload([bfsFeature(), bfsFeature({ id: 'HOT', name: 'Hot probe', lat: 49, lon: 9, value: 0.9 }), bfsFeature({ id: 'B3', lat: 53, lon: 13, value: 0.1 })]),
    stuk: stukPayload(stukElement(60.2229, 25.1788, 0.111)),
  });
  const result = await briefing({ now });
  assert.equal(result.status, 'healthy');
  assert.equal(result.anomaly, false);
  assert.equal(result.elevated.length, 1);
  assert.equal(result.elevated[0].name, 'Hot probe');
  assert.match(result.signals[0], /^1 European station above 0\.5 µSv\/h \(peak 0\.9 at Hot probe\); network median 0\.13 is normal/);
});

test('a network-wide rise is an anomaly', async t => {
  mockFeeds(t, {
    bfs: bfsPayload([bfsFeature({ value: 0.6 }), bfsFeature({ id: 'B2', lat: 48, lon: 11, value: 0.7 })]),
    stuk: stukPayload(stukElement(60.2229, 25.1788, 0.55)),
  });
  const result = await briefing({ now });
  assert.equal(result.anomaly, true);
  assert.match(result.signals[0], /^ELEVATED RADIATION across European background network: BfS median 0\.65 µSv\/h over 2 stations; STUK median 0\.55/);
});

test('a rise across the smaller network is not hidden by the larger one', async t => {
  const bfsFeatures = Array.from({ length: 12 }, (_, i) => bfsFeature({ id: `B${i}`, lat: 47 + i * 0.6, lon: 8 + i * 0.6, value: 0.1 }));
  const stukElements = Array.from({ length: 12 }, (_, i) => stukElement(60 + i * 0.6, 22 + i * 0.6, 0.6));
  mockFeeds(t, { bfs: bfsPayload(bfsFeatures), stuk: stukPayload(...stukElements) });
  const result = await briefing({ now });
  assert.equal(result.anomaly, true);
  assert.match(result.signals[0], /STUK median 0\.60 µSv\/h over 12 stations/);
  assert.doesNotMatch(result.signals[0], /BfS median/);
  assert.equal(result.elevatedCount, 12);
  assert.equal(result.elevated.length, 10);
});

test('the elevated-station count is not capped by the listed top ten', async t => {
  const hot = Array.from({ length: 14 }, (_, i) => bfsFeature({ id: `H${i}`, name: `Hot ${i}`, lat: 47 + i * 0.6, lon: 8, value: 0.6 }));
  const normal = Array.from({ length: 30 }, (_, i) => bfsFeature({ id: `N${i}`, lat: 47 + i * 0.3, lon: 12, value: 0.1 }));
  mockFeeds(t, { bfs: bfsPayload([...hot, ...normal]), stuk: stukPayload(stukElement(60.2229, 25.1788, 0.111)) });
  const result = await briefing({ now });
  assert.equal(result.anomaly, false);
  assert.equal(result.elevatedCount, 14);
  assert.equal(result.elevated.length, 10);
  assert.match(result.signals[0], /^14 European stations above 0\.5/);
});

test('dashboard synthesizes a radBackground block and counts the source in health', async () => {
  const result = await synthesize({
    crucix: { timestamp: recent }, errors: [],
    sources: { 'Radiation-EU': {
      status: 'healthy', stationsFresh: 3, medianUSvH: 0.11, maxUSvH: 0.23, anomaly: false, elevated: [],
      networks: [{ network: 'BfS', status: 'healthy', stations: 2, fresh: 2, medianUSvH: 0.11, maxUSvH: 0.23, maxStation: { name: 'Seßlach' }, lastObservationAt: recent }],
      stations: [{ network: 'BfS', name: 'Seßlach', lat: 50.18, lon: 10.84, uSvH: 0.14, observedAt: recent }, { network: 'BfS', name: 'bad', lat: null, lon: 1, uSvH: 0.1 }],
      signals: ['European background normal'], lastObservationAt: recent,
    } },
  }, { now, newsLoader: async () => [] });
  assert.equal(result.radBackground.medianUSvH, 0.11);
  assert.equal(result.radBackground.stations.length, 1);
  assert.equal(result.radBackground.networks[0].maxStation, 'Seßlach');
  assert.equal(result.health.find(h => h.n === 'Radiation-EU').status, 'healthy');
});

test('a missing source leaves radBackground empty but well-formed', async () => {
  const result = await synthesize({ crucix: { timestamp: recent }, errors: [{ name: 'Radiation-EU', error: 'timed out' }], sources: {} }, { now, newsLoader: async () => [] });
  assert.equal(result.radBackground.status, 'failed');
  assert.equal(result.radBackground.medianUSvH, null);
  assert.deepEqual(result.radBackground.stations, []);
  assert.equal(result.health.find(h => h.n === 'Radiation-EU').status, 'failed');
});
