// EPA RadNet — Radiation Monitoring Network
// No auth required. Government open data via Envirofacts REST API.
// Monitors ambient radiation levels across the US via fixed monitoring stations.
// Complements Safecast (citizen science) with official government readings.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://data.epa.gov/dmapservice';
const RESULTS_TIMEOUT_MS = 16000;
const LOCATIONS_TIMEOUT_MS = 8000;
const RECENT_LOOKBACK_DAYS = 400;
let lastSuccessfulBriefing = null;

const ANALYTE_NAMES = {
  ALPHA: 'GROSS ALPHA',
  BETA: 'GROSS BETA',
  I131: 'IODINE-131',
  CS137: 'CESIUM-137',
  CS134: 'CESIUM-134',
  SR90: 'STRONTIUM-90',
  H3: 'TRITIUM',
};

// Key US cities with RadNet monitoring stations
const MONITORING_STATIONS = {
  washingtonDC:  { label: 'Washington, DC',   state: 'DC', lat: 38.9, lon: -77.0 },
  newYork:       { label: 'New York, NY',      state: 'NY', lat: 40.7, lon: -74.0 },
  losAngeles:    { label: 'Los Angeles, CA',   state: 'CA', lat: 34.1, lon: -118.2 },
  chicago:       { label: 'Chicago, IL',       state: 'IL', lat: 41.9, lon: -87.6 },
  seattle:       { label: 'Seattle, WA',       state: 'WA', lat: 47.6, lon: -122.3 },
  denver:        { label: 'Denver, CO',        state: 'CO', lat: 39.7, lon: -105.0 },
  honolulu:      { label: 'Honolulu, HI',      state: 'HI', lat: 21.3, lon: -157.9 },
  anchorage:     { label: 'Anchorage, AK',     state: 'AK', lat: 61.2, lon: -149.9 },
  miami:         { label: 'Miami, FL',         state: 'FL', lat: 25.8, lon: -80.2 },
  sanFrancisco:  { label: 'San Francisco, CA', state: 'CA', lat: 37.8, lon: -122.4 },
};

// Analyte types that indicate concerning radiation
const KEY_ANALYTES = [
  'GROSS BETA',
  'GROSS ALPHA',
  'IODINE-131',
  'CESIUM-137',
  'CESIUM-134',
  'STRONTIUM-90',
  'TRITIUM',
  'URANIUM',
  'PLUTONIUM',
];

// Normal background radiation thresholds (pCi/L or pCi/m3 depending on medium)
const THRESHOLDS = {
  'GROSS BETA': { normal: 1.0, elevated: 5.0, unit: 'pCi/m3' },
  'GROSS ALPHA': { normal: 0.05, elevated: 0.15, unit: 'pCi/m3' },
  'IODINE-131': { normal: 0.01, elevated: 0.1, unit: 'pCi/m3' },
  'CESIUM-137': { normal: 0.01, elevated: 0.1, unit: 'pCi/m3' },
  'CESIUM-134': { normal: 0.001, elevated: 0.01, unit: 'pCi/m3' },
};

// Get recent RadNet laboratory results joined to their analysis and sample.
export async function getAnalyticalResults(opts = {}) {
  const { rows = 100 } = opts;
  const since = new Date(Date.now() - RECENT_LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  const path = [
    'radnet.erm_analysis',
    'left', 'radnet.erm_result', 'ana_num', 'equals', 'ana_num',
    'left', 'radnet.erm_sample', 'samp_num', 'equals', 'samp_num',
    'radnet.erm_result.result_date', 'greaterThan', since,
    'sort', 'radnet.erm_result.result_date:desc',
    `1:${Math.min(Math.max(Number(rows) || 100, 1), 250)}`,
    'json',
  ].join('/');
  return safeFetch(
    `${BASE}/${path}`,
    { timeout: RESULTS_TIMEOUT_MS, retries: 0 }
  );
}

async function getLocations(locationNumbers) {
  const ids = [...new Set(locationNumbers.filter(Number.isFinite))].slice(0, 250);
  if (!ids.length) return [];
  return safeFetch(
    `${BASE}/radnet.erm_location/loc_num/in/${ids.join(',')}/1:${ids.length}/json`,
    { timeout: LOCATIONS_TIMEOUT_MS, retries: 0 }
  );
}

// Lookup coords by city name or state
const CITY_COORDS = Object.fromEntries(
  Object.values(MONITORING_STATIONS).map(s => [s.label.split(',')[0].toUpperCase(), s])
);

// Compact a reading for briefing output
function compactReading(r, locations) {
  const location = locations.get(Number(r.loc_num));
  const city = String(location?.city_name || location?.station || '').toUpperCase().trim();
  const station = CITY_COORDS[city];
  const result = Number(r.result_amount);
  return {
    location: location?.city_name || location?.station || `Station ${r.loc_num || 'unknown'}`,
    state: location?.state_abbr || null,
    analyte: ANALYTE_NAMES[r.analyte_id] || r.analyte_id || null,
    result: Number.isFinite(result) ? result : null,
    unit: r.result_unit || null,
    collectDate: r.result_date || r.collect_end || null,
    medium: r.mat_id || null,
    lat: station?.lat || null,
    lon: station?.lon || null,
  };
}

// Check a reading against known thresholds
function checkReading(reading) {
  if (reading.result === null || reading.result <= 0) return null;
  const threshold = THRESHOLDS[reading.analyte?.toUpperCase()];
  if (!threshold) return null;
  if (String(reading.unit || '').toUpperCase() !== threshold.unit.toUpperCase()) return null;

  if (reading.result > threshold.elevated) {
    return {
      level: 'ELEVATED',
      reading,
      threshold: threshold.elevated,
      ratio: (reading.result / threshold.elevated).toFixed(1),
    };
  }
  if (reading.result > threshold.normal * 3) {
    return {
      level: 'ABOVE_NORMAL',
      reading,
      threshold: threshold.normal,
      ratio: (reading.result / threshold.normal).toFixed(1),
    };
  }
  return null;
}

// Briefing — get recent radiation readings from EPA network, flag anomalies
export async function briefing() {
  const readings = [];
  const signals = [];

  const recentData = await getAnalyticalResults({ rows: 100 });
  if (recentData?.error) {
    const error = recentData.error;
    if (lastSuccessfulBriefing) {
      return {
        ...lastSuccessfulBriefing,
        timestamp: new Date().toISOString(),
        stale: true,
        error: `EPA refresh failed: ${error}`,
      };
    }
    throw new Error(`EPA RadNet requests failed: ${error || 'unknown error'}`);
  }

  const recentRecords = Array.isArray(recentData) ? recentData : [];
  const locationData = await getLocations(recentRecords.map(record => Number(record.loc_num)));
  const locations = new Map(
    (Array.isArray(locationData) ? locationData : []).map(location => [Number(location.loc_num), location])
  );

  // Compact all readings
  const allReadings = recentRecords.map(record => compactReading(record, locations));
  readings.push(...allReadings);

  // Check all readings against thresholds
  for (const reading of readings) {
    const alert = checkReading(reading);
    if (alert) {
      if (alert.level === 'ELEVATED') {
        signals.push(
          `ELEVATED ${reading.analyte} at ${reading.location}, ${reading.state}: ` +
          `${reading.result} ${reading.unit || ''} (${alert.ratio}x threshold) [${reading.collectDate}]`
        );
      } else {
        signals.push(
          `ABOVE NORMAL ${reading.analyte} at ${reading.location}, ${reading.state}: ` +
          `${reading.result} ${reading.unit || ''} (${alert.ratio}x normal) [${reading.collectDate}]`
        );
      }
    }
  }

  // Summarize by state
  const byState = {};
  for (const r of readings) {
    const st = r.state || 'UNK';
    if (!byState[st]) byState[st] = { count: 0, analytes: new Set() };
    byState[st].count++;
    if (r.analyte) byState[st].analytes.add(r.analyte);
  }

  // Convert sets to arrays for JSON
  const stateSummary = Object.fromEntries(
    Object.entries(byState).map(([st, info]) => [
      st,
      { count: info.count, analytes: [...info.analytes] },
    ])
  );

  const result = {
    source: 'EPA RadNet',
    timestamp: new Date().toISOString(),
    totalReadings: readings.length,
    readings: readings.slice(0, 50), // cap for briefing size
    stateSummary,
    signals: signals.length > 0
      ? signals
      : ['No elevated EPA RadNet laboratory results detected in the latest available samples'],
    monitoredAnalytes: KEY_ANALYTES,
    thresholds: THRESHOLDS,
    locationWarning: locationData?.error ? `Location metadata unavailable: ${locationData.error}` : undefined,
    note: 'EPA laboratory results are quality-controlled and may lag collection by days or weeks. Near-real-time gamma data are a separate RadNet dataset.',
  };
  lastSuccessfulBriefing = result;
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('epa.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
