// Safecast — Global radiation monitoring (150M+ readings)
// No auth required. CC0 public domain. Citizen-science network.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.safecast.org';

// Get recent measurements in an area
export async function getMeasurements(opts = {}) {
  const {
    latitude = null,
    longitude = null,
    distance = 100, // km
    limit = 50,
    since = null,
    signal,
  } = opts;

  const params = new URLSearchParams({ limit: String(limit) });
  if (latitude && longitude) {
    params.set('latitude', String(latitude));
    params.set('longitude', String(longitude));
    params.set('distance', String(distance * 1000)); // meters
  }
  if (since) params.set('since', since);

  return safeFetch(`${BASE}/measurements.json?${params}`, { timeout: 12000, signal });
}

// Key nuclear sites to monitor
const NUCLEAR_SITES = {
  zaporizhzhia: { lat: 47.51, lon: 34.58, label: 'Zaporizhzhia NPP (Ukraine)', radius: 100 },
  chernobyl: { lat: 51.39, lon: 30.1, label: 'Chernobyl Exclusion Zone', radius: 50 },
  bushehr: { lat: 28.83, lon: 50.89, label: 'Bushehr NPP (Iran)', radius: 100 },
  yongbyon: { lat: 39.8, lon: 125.75, label: 'Yongbyon (North Korea)', radius: 100 },
  fukushima: { lat: 37.42, lon: 141.03, label: 'Fukushima Daiichi', radius: 50 },
  dimona: { lat: 31.0, lon: 35.15, label: 'Dimona (Israel)', radius: 100 },
};

// Briefing — check radiation levels near key nuclear sites
//
// A site whose request failed reports `error` and is *not* counted as "quiet":
// an empty reading list from a dead endpoint is not evidence of normal
// background, so the all-clear signal is withheld whenever anything failed.
export async function briefing(opts = {}) {
  const { signal } = opts || {};

  const results = await Promise.all(
    Object.entries(NUCLEAR_SITES).map(async ([key, site]) => {
      const data = await getMeasurements({
        latitude: site.lat,
        longitude: site.lon,
        distance: site.radius,
        limit: 10,
        signal,
      });

      const base = {
        site: site.label,
        key,
        recentReadings: 0,
        avgCPM: null,
        maxCPM: null,
        anomaly: false,
        lastReading: null,
      };

      if (!Array.isArray(data)) {
        return { ...base, error: data?.error || 'Safecast returned an unexpected payload' };
      }

      const values = data.map(m => m.value).filter(v => typeof v === 'number');
      const avgCPM = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

      return {
        ...base,
        recentReadings: values.length,
        avgCPM,
        maxCPM: values.length > 0 ? Math.max(...values) : null,
        // Normal background: 10-80 CPM. >100 CPM warrants attention.
        anomaly: avgCPM !== null && avgCPM > 100,
        lastReading: data[0]?.captured_at || null,
      };
    })
  );

  const anomalies = results.filter(r => r.anomaly);
  const failures = results.filter(r => r.error);

  const signals = anomalies.map(
    a => `ELEVATED RADIATION at ${a.site}: ${a.avgCPM?.toFixed(1)} CPM (normal: 10-80)`
  );
  // Only claim "all normal" when every site actually answered.
  if (!signals.length && !failures.length) {
    signals.push('All monitored nuclear sites within normal radiation levels');
  }

  const out = {
    source: 'Safecast',
    timestamp: new Date().toISOString(),
    sites: results,
    signals,
  };

  if (failures.length) {
    out.error = failures.length === results.length
      ? `Safecast unavailable for all ${results.length} sites: ${failures[0].error}`
      : `Safecast unavailable for ${failures.length}/${results.length} sites: ${failures[0].error}`;
  }

  return out;
}

if (process.argv[1]?.endsWith('safecast.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
