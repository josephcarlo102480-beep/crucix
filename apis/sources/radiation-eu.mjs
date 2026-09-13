// Radiation-EU — European ambient gamma dose-rate background.
// Two national state networks, no auth, open data:
//   • BfS ODL (Germany): ~1,700 probes, hourly, GeoServer WFS → JSON.
//   • STUK via FMI open data (Finland): ~240 stations, 10-minute averages, WFS → XML.
// Both report ambient dose equivalent rate in µSv/h. This is a BACKGROUND layer:
// it shows what "normal" looks like across Europe so a Safecast or news signal
// can be judged against a dense, calibrated state network.

import { safeFetch } from '../utils/fetch.mjs';
import { RADIATION_MAX_AGE_MS } from '../../lib/radiation.mjs';

export const BFS_URL = 'https://www.imis.bfs.de/ogc/opendata/ows?service=WFS&version=1.1.0&request=GetFeature'
  + '&typeName=opendata:odlinfo_odl_1h_latest&outputFormat=application/json';
export const STUK_URL = 'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature'
  + '&storedquery_id=stuk::observations::external-radiation::latest::simple';

// Normal European background is ~0.05–0.20 µSv/h. Both thresholds are display
// policy, not regulatory limits: `ELEVATED_STATION_USVH` names individual probes
// worth a look; `ANOMALY_USVH` on the network MEDIAN means the region as a whole
// has moved, which is what a release would look like.
export const ELEVATED_STATION_USVH = 0.5;
export const ANOMALY_USVH = 0.3;

// Stations are thinned to the highest reading per grid cell for the map payload;
// statistics are computed over every station first.
export const THIN_GRID_DEG = 0.5;

const round = (n, dp) => Number(Number(n).toFixed(dp));

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length ? (v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2) : null;
}

function usable(station, now) {
  return Number.isFinite(station.lat) && Number.isFinite(station.lon)
    && Number.isFinite(station.uSvH) && station.uSvH >= 0
    && Number.isFinite(Date.parse(station.observedAt))
    && Date.parse(station.observedAt) <= now + 5 * 60 * 1000;
}

// --- BfS (Germany) -----------------------------------------------------------
export function parseBfs(payload, now = Date.now()) {
  if (!payload || !Array.isArray(payload.features)) return null;
  return payload.features.map(f => {
    const p = f?.properties || {};
    const [lon, lat] = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : [];
    return {
      network: 'BfS', id: p.id || null, name: p.name || p.id || 'BfS probe',
      lat: Number(lat), lon: Number(lon), uSvH: p.value == null || p.value === '' ? NaN : Number(p.value), observedAt: p.end_measure || null,
      // BfS marks probes out of service (site_status !== 1) and unvalidated hours.
      inService: p.site_status == null || Number(p.site_status) === 1,
    };
  }).filter(s => s.inService && usable(s, now));
}

// --- STUK (Finland) ----------------------------------------------------------
// The "simple" stored query returns one BsWfsElement per (station, parameter).
// We want DR_PT10M_avg — the 10-minute mean external dose rate. Regex parsing
// is deliberate: the document is flat and we avoid a dependency for one feed.
const ELEMENT_RE = /<BsWfs:BsWfsElement\b[\s\S]*?<\/BsWfs:BsWfsElement>/g;
const pick = (block, tag) => block.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*<\\/${tag}>`))?.[1] ?? null;

export function parseStuk(xml, now = Date.now()) {
  if (typeof xml !== 'string' || !xml.includes('BsWfsElement')) return null;
  const out = [];
  for (const block of xml.match(ELEMENT_RE) || []) {
    if (pick(block, 'BsWfs:ParameterName') !== 'DR_PT10M_avg') continue;
    const [lat, lon] = (pick(block, 'gml:pos') || '').trim().split(/\s+/).map(Number);
    const s = {
      network: 'STUK', id: null, name: 'STUK station',
      lat, lon, uSvH: Number(pick(block, 'BsWfs:ParameterValue')), observedAt: pick(block, 'BsWfs:Time'),
    };
    if (!usable(s, now)) continue;
    s.id = `STUK:${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
    s.name = `STUK ${s.lat.toFixed(2)}°N ${s.lon.toFixed(2)}°E`;
    out.push(s);
  }
  return out;
}

// --- Aggregation -------------------------------------------------------------
export function thinStations(stations, cellDeg = THIN_GRID_DEG) {
  const cells = new Map();
  for (const s of stations) {
    const key = `${Math.floor(s.lat / cellDeg)}:${Math.floor(s.lon / cellDeg)}`;
    const cur = cells.get(key);
    if (!cur || s.uSvH > cur.uSvH) cells.set(key, s);
  }
  return [...cells.values()];
}

function summariseNetwork(network, stations, fetchError, now) {
  if (stations === null) {
    return { network, status: 'failed', error: fetchError || `${network} returned an unexpected payload`,
      stations: 0, fresh: 0, medianUSvH: null, maxUSvH: null, lastObservationAt: null };
  }
  const fresh = stations.filter(s => now - Date.parse(s.observedAt) <= RADIATION_MAX_AGE_MS);
  const lastObservationAt = stations.map(s => s.observedAt).sort().at(-1) || null;
  if (!stations.length) {
    return { network, status: 'failed', error: `${network} returned no usable stations`,
      stations: 0, fresh: 0, medianUSvH: null, maxUSvH: null, lastObservationAt };
  }
  if (!fresh.length) {
    return { network, status: 'stale', error: `${network}: ${stations.length} stations, none observed in the last 24 hours`,
      stations: stations.length, fresh: 0, medianUSvH: null, maxUSvH: null, lastObservationAt };
  }
  const values = fresh.map(s => s.uSvH);
  const max = fresh.reduce((a, b) => (b.uSvH > a.uSvH ? b : a));
  return {
    network, status: 'healthy', stations: stations.length, fresh: fresh.length,
    medianUSvH: round(median(values), 3), maxUSvH: round(max.uSvH, 3),
    maxStation: { name: max.name, lat: round(max.lat, 3), lon: round(max.lon, 3), observedAt: max.observedAt },
    lastObservationAt,
  };
}

export async function briefing(opts = {}) {
  const { signal, now = Date.now() } = opts || {};
  const [bfsRaw, stukRaw] = await Promise.all([
    safeFetch(BFS_URL, { timeout: 25000, retries: 0, signal }),
    safeFetch(STUK_URL, { timeout: 25000, retries: 0, signal, responseType: 'text' }),
  ]);

  const bfs = bfsRaw?.error ? null : parseBfs(bfsRaw, now);
  const stukText = typeof stukRaw === 'string' ? stukRaw : (stukRaw?.text ?? stukRaw?.rawText);
  const stuk = stukRaw?.error ? null : parseStuk(stukText, now);

  const networks = [
    summariseNetwork('BfS', bfs, bfsRaw?.error, now),
    summariseNetwork('STUK', stuk, stukRaw?.error, now),
  ];
  const all = [...(bfs || []), ...(stuk || [])];
  const fresh = all.filter(s => now - Date.parse(s.observedAt) <= RADIATION_MAX_AGE_MS);
  const elevated = fresh.filter(s => s.uSvH >= ELEVATED_STATION_USVH)
    .sort((a, b) => b.uSvH - a.uSvH).slice(0, 10)
    .map(s => ({ network: s.network, name: s.name, lat: round(s.lat, 3), lon: round(s.lon, 3), uSvH: round(s.uSvH, 3), observedAt: s.observedAt }));

  const healthy = networks.filter(n => n.status === 'healthy');
  const medianUSvH = fresh.length ? round(median(fresh.map(s => s.uSvH)), 3) : null;
  const anomaly = medianUSvH === null ? null : medianUSvH > ANOMALY_USVH;

  const signals = [];
  if (anomaly) signals.push(`ELEVATED RADIATION across European background network: median ${medianUSvH.toFixed(2)} µSv/h over ${fresh.length} stations (normal: <0.30)`);
  else if (elevated.length) signals.push(`${elevated.length} European station${elevated.length === 1 ? '' : 's'} above ${ELEVATED_STATION_USVH} µSv/h (peak ${elevated[0].uSvH} at ${elevated[0].name}); network median ${medianUSvH.toFixed(2)} is normal`);
  else if (healthy.length === networks.length) signals.push(`European background normal: median ${medianUSvH.toFixed(2)} µSv/h across ${fresh.length} state monitors (${healthy.map(n => n.network).join(' + ')})`);

  const failed = networks.filter(n => n.status !== 'healthy');
  const out = {
    source: 'Radiation-EU',
    timestamp: new Date().toISOString(),
    networks,
    stationsTotal: all.length,
    stationsFresh: fresh.length,
    medianUSvH,
    maxUSvH: fresh.length ? round(Math.max(...fresh.map(s => s.uSvH)), 3) : null,
    anomaly,
    elevated,
    // Thinned for the map: highest reading per grid cell, coordinates rounded.
    stations: thinStations(fresh).map(s => ({
      network: s.network, name: s.name, lat: round(s.lat, 3), lon: round(s.lon, 3), uSvH: round(s.uSvH, 3), observedAt: s.observedAt,
    })),
    signals,
    lastObservationAt: networks.map(n => n.lastObservationAt).filter(Boolean).sort().at(-1) || null,
    status: !healthy.length
      ? (networks.some(n => n.status === 'stale') ? 'stale' : 'failed')
      : failed.length ? 'degraded' : 'healthy',
  };
  if (failed.length) {
    out.error = healthy.length
      ? `${failed.map(n => n.network).join(', ')} unavailable: ${failed[0].error}`
      : `European radiation networks unavailable: ${failed[0].error}`;
  }
  return out;
}

if (process.argv[1]?.endsWith('radiation-eu.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify({ ...data, stations: `${data.stations.length} stations (omitted)` }, null, 2));
}
