// Safecast — real-time radiation sensor network (Solarcast, Pointcast, Radnote).
// No auth required. CC0 public domain.
//
// The feed is one JSON document listing every device with its most recent
// reading: https://tt.safecast.org/devices. It replaces the old per-site
// queries against api.safecast.org/measurements.json, which only holds
// bGeigie survey drives (newest real data near our sites: 2017–2023) and
// therefore never yielded a current observation.

import { safeFetch } from '../utils/fetch.mjs';
import { RADIATION_MAX_AGE_MS } from '../../lib/radiation.mjs';

export const DEVICES_URL = 'https://tt.safecast.org/devices';

// Key nuclear sites to monitor. `radius` is km; fixed sensors are sparse, so
// the radius is wider than the old survey-drive search.
export const NUCLEAR_SITES = {
  zaporizhzhia: { lat: 47.51, lon: 34.58, label: 'Zaporizhzhia NPP (Ukraine)', radius: 200 },
  chernobyl: { lat: 51.39, lon: 30.1, label: 'Chernobyl Exclusion Zone', radius: 150 },
  bushehr: { lat: 28.83, lon: 50.89, label: 'Bushehr NPP (Iran)', radius: 300 },
  yongbyon: { lat: 39.8, lon: 125.75, label: 'Yongbyon (North Korea)', radius: 300 },
  fukushima: { lat: 37.42, lon: 141.03, label: 'Fukushima Daiichi', radius: 80 },
  dimona: { lat: 31.0, lon: 35.15, label: 'Dimona (Israel)', radius: 300 },
};

// Geiger tube fields the feed exposes, in preference order, with the
// approximate CPM-per-µSv/h sensitivity Safecast uses for each tube family.
// Conversions are for Cs-137-referenced gamma and are indicative only.
const TUBES = [
  { field: 'lnd_7318u', cpmPerUSvH: 334 },
  { field: 'lnd_7318c', cpmPerUSvH: 334 },
  { field: 'lnd_7128ec', cpmPerUSvH: 334 },
  { field: 'lnd_78017w', cpmPerUSvH: 334 },
  { field: 'lnd_712u', cpmPerUSvH: 120 },
];

// Normal background is roughly 0.05–0.20 µSv/h (≈15–70 CPM on an LND 7318).
// Above 0.30 µSv/h warrants attention.
export const ANOMALY_USVH = 0.3;

// A sensor silent for this long is treated as retired: it no longer counts as
// coverage, so a site whose only sensors died years ago reads `no_coverage`
// rather than perpetually `stale`.
export const RETIRED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const EARTH_KM = 6371;
export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

// Reduce a raw feed entry to one radiation reading, or null when the device
// carries no usable Geiger field, position or timestamp.
export function normaliseDevice(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.loc_lat);
  const lon = Number(raw.loc_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const captured = Date.parse(raw.when_captured);
  if (!Number.isFinite(captured) || captured > now + 5 * 60 * 1000) return null;
  const tube = TUBES.find(t => Number.isFinite(Number(raw[t.field])) && Number(raw[t.field]) >= 0);
  if (!tube) return null;
  const cpm = Number(raw[tube.field]);
  return {
    id: String(raw.device_urn || raw.device || ''),
    name: raw.device_sn || raw.loc_name || String(raw.device || 'device'),
    place: raw.loc_name || null,
    country: raw.loc_country || null,
    lat, lon, cpm,
    uSvH: cpm / tube.cpmPerUSvH,
    tube: tube.field,
    capturedAt: String(raw.when_captured),
  };
}

export async function getDevices(opts = {}) {
  return safeFetch(DEVICES_URL, { timeout: 25000, retries: 0, signal: opts.signal });
}

function summariseSite(key, site, devices, now) {
  const base = {
    site: site.label, key, recentReadings: 0, avgCPM: null, medianCPM: null, maxCPM: null, avgUSvH: null,
    anomaly: null, status: 'unknown', lastReading: null, devices: [],
  };
  const nearby = devices
    .map(d => ({ ...d, km: distanceKm(site.lat, site.lon, d.lat, d.lon) }))
    .filter(d => d.km <= site.radius && now - Date.parse(d.capturedAt) <= RETIRED_AFTER_MS)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  if (!nearby.length) {
    return { ...base, status: 'no_coverage', error: `No Safecast real-time sensors within ${site.radius} km` };
  }
  const fresh = nearby.filter(d => now - Date.parse(d.capturedAt) <= RADIATION_MAX_AGE_MS);
  const lastReading = nearby[0].capturedAt;
  if (!fresh.length) {
    return { ...base, status: 'stale', lastReading, devices: nearby.slice(0, 10),
      error: `${nearby.length} sensor${nearby.length === 1 ? '' : 's'} nearby but none reported in the last 24 hours` };
  }
  // Sensors inside the Chernobyl and Fukushima exclusion zones read 1–2 µSv/h
  // permanently, so the site figure is the MEDIAN across sensors — the typical
  // regional dose rate — and an anomaly means the region as a whole is elevated.
  // `avgCPM` keeps its historical name for the dashboard but carries the median.
  const cpm = fresh.map(d => d.cpm);
  const medianCPM = median(cpm);
  const avgUSvH = median(fresh.map(d => d.uSvH));
  return {
    ...base,
    recentReadings: fresh.length,
    avgCPM: medianCPM,
    medianCPM,
    maxCPM: Math.max(...cpm),
    avgUSvH,
    anomaly: avgUSvH > ANOMALY_USVH,
    status: 'healthy',
    lastReading,
    devices: fresh.slice(0, 10).map(d => ({
      name: d.name, place: d.place, cpm: d.cpm, uSvH: Number(d.uSvH.toFixed(3)),
      km: Number(d.km.toFixed(1)), capturedAt: d.capturedAt,
    })),
  };
}

// Briefing — radiation levels near key nuclear sites.
//
// Per-site status: healthy (fresh sensors), stale (sensors reported within 30
// days but not 24h), no_coverage (no live sensors in range — a known gap, not
// an outage),
// failed (feed unavailable). "All normal" is only claimed when every covered
// site is healthy; uncovered sites are named rather than silently skipped.
export async function briefing(opts = {}) {
  const { signal, now = Date.now() } = opts || {};
  const entries = Object.entries(NUCLEAR_SITES);
  const raw = await getDevices({ signal });

  if (!Array.isArray(raw)) {
    const error = raw?.error || 'Safecast device feed returned an unexpected payload';
    return {
      source: 'Safecast', timestamp: new Date().toISOString(), status: 'failed', error: `Safecast real-time feed unavailable: ${error}`,
      sites: entries.map(([key, site]) => ({
        site: site.label, key, recentReadings: 0, avgCPM: null, medianCPM: null, maxCPM: null, avgUSvH: null,
        anomaly: null, status: 'failed', lastReading: null, devices: [], error,
      })),
      signals: [], lastObservationAt: null, devicesTotal: 0, devicesFresh: 0,
    };
  }

  const devices = raw.map(d => normaliseDevice(d, now)).filter(Boolean);
  const devicesFresh = devices.filter(d => now - Date.parse(d.capturedAt) <= RADIATION_MAX_AGE_MS).length;
  const sites = entries.map(([key, site]) => summariseSite(key, site, devices, now));

  const covered = sites.filter(s => s.status !== 'no_coverage');
  const uncovered = sites.filter(s => s.status === 'no_coverage');
  const anomalies = sites.filter(s => s.anomaly);
  const gaps = covered.filter(s => s.status !== 'healthy');

  const signals = anomalies.map(a =>
    `ELEVATED RADIATION at ${a.site}: ${a.avgUSvH.toFixed(2)} µSv/h median across ${a.recentReadings} sensors (normal: <0.30)`);
  if (!signals.length && covered.length && !gaps.length) {
    signals.push(covered.length === sites.length
      ? 'All monitored nuclear sites within normal radiation levels'
      : `Radiation normal at all ${covered.length} sites with sensor coverage (no sensors: ${uncovered.map(s => s.site).join(', ')})`);
  }

  const out = {
    source: 'Safecast',
    timestamp: new Date().toISOString(),
    sites,
    signals,
    devicesTotal: devices.length,
    devicesFresh,
    lastObservationAt: sites.map(s => s.lastReading).filter(Boolean).sort().at(-1) || null,
    status: !covered.length ? 'failed'
      : gaps.length === covered.length ? (gaps.some(s => s.status === 'stale') ? 'stale' : 'failed')
      : gaps.length ? 'degraded' : 'healthy',
  };
  if (!covered.length) out.error = 'No Safecast real-time sensors near any monitored site';
  else if (gaps.length) out.error = `No current observations for ${gaps.length}/${covered.length} covered sites: ${gaps[0].error}`;
  return out;
}

if (process.argv[1]?.endsWith('safecast.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
