// Space/Satellite Activity Monitoring
// Uses tle.ivanstanojevic.me for public TLE data.
// Tracks: Recent launches, ISS position, satellite counts, space debris.

import { safeFetch } from '../utils/fetch.mjs';

const TLE_BASE = 'https://tle.ivanstanojevic.me/api/tle';

// Fetch TLEs from the alternative API
async function fetchTLEs(query, pageSize = 100) {
  const url = `${TLE_BASE}/?search=${encodeURIComponent(query)}&page_size=${pageSize}`;
  const data = await safeFetch(url, { timeout: 20000 });
  if (data.error) return { error: data.error };
  // API returns { member: [...], parameters: {...}, totalItems: N }
  return Array.isArray(data.member) ? data.member : [];
}

// Fetch a single satellite by NORAD ID
async function fetchByNorad(noradId) {
  const data = await safeFetch(`${TLE_BASE}/${noradId}`, { timeout: 15000 });
  return data;
}

// Get recent launches (search for recently cataloged objects)
async function getRecentLaunches() {
  // Fetch a broad set of recent TLEs — the API sorts by most recent
  const data = await fetchTLEs('', 100);
  if (data.error) return { error: data.error };
  if (!Array.isArray(data)) return { error: 'Unexpected response format' };

  const launches = data.map(sat => ({
    name: sat.name,
    noradId: sat.satelliteId,
    line1: sat.line1,
    line2: sat.line2,
  })).filter(s => s.name && s.noradId);

  const byCountry = {};
  // Parse country from name patterns (approximation)
  launches.forEach(l => {
    const name = (l.name || '').toUpperCase();
    let country = 'UNK';
    if (name.includes('STARLINK') || name.includes('GPS') || name.includes('GOES') || name.includes('TDRS')) country = 'US';
    else if (name.includes('COSMOS') || name.includes('KOSMOS')) country = 'CIS';
    else if (name.includes('CZ-') || name.includes('YAOGAN') || name.includes('BEIDOU')) country = 'PRC';
    byCountry[country] = (byCountry[country] || 0) + 1;
  });

  return { totalObjects: launches.length, recentLaunches: launches.slice(0, 25), byCountry };
}

// Get space station data
async function getStationData() {
  const data = await fetchTLEs('stations', 20);
  if (data.error) return { error: data.error };
  if (!Array.isArray(data)) return { error: 'Unexpected response format' };

  // Also fetch ISS directly by NORAD ID
  const iss = await fetchByNorad(25544);

  const stations = data.map(sat => ({
    name: sat.name,
    noradId: sat.satelliteId,
    line1: sat.line1,
    line2: sat.line2,
  })).filter(s => s.name);

  const issData = iss && !iss.error ? {
    name: iss.name,
    noradId: iss.satelliteId,
    line1: iss.line1,
    line2: iss.line2,
  } : null;

  return { totalStations: stations.length, stations: stations.slice(0, 10), iss: issData };
}

// Get military satellite count
async function getMilitaryCount() {
  const data = await fetchTLEs('military', 100);
  if (data.error) return { count: 0, error: data.error };
  if (!Array.isArray(data)) return { count: 0, error: 'Unexpected format' };

  return { count: data.length, byCountry: {} };
}

// Get mega-constellation stats (Starlink, OneWeb)
async function getConstellationStats() {
  const [starlink, oneweb] = await Promise.all([
    fetchTLEs('starlink', 100),
    fetchTLEs('oneweb', 100),
  ]);

  return {
    starlink: Array.isArray(starlink) ? starlink.length : 0,
    oneweb: Array.isArray(oneweb) ? oneweb.length : 0,
  };
}

// Generate signals
function generateSignals(data) {
  const signals = [];

  if (data.launches?.totalObjects > 50) {
    signals.push(`HIGH LAUNCH TEMPO: ${data.launches.totalObjects} new objects tracked recently`);
  }

  const byCountry = data.launches?.byCountry || {};
  const cnLaunches = byCountry['PRC'] || byCountry['CN'] || 0;
  const ruLaunches = byCountry['CIS'] || byCountry['RU'] || 0;

  if (cnLaunches > 10) {
    signals.push(`CHINA SPACE ACTIVITY: ${cnLaunches} objects launched recently`);
  }
  if (ruLaunches > 5) {
    signals.push(`RUSSIA SPACE ACTIVITY: ${ruLaunches} objects launched recently`);
  }
  if (data.military?.count > 500) {
    signals.push(`MILITARY CONSTELLATION: ${data.military.count} tracked military satellites`);
  }
  if (data.constellations?.starlink > 6000) {
    signals.push(`STARLINK MEGA-CONSTELLATION: ${data.constellations.starlink} active satellites`);
  }

  return signals;
}

// Briefing export
export async function briefing() {
  try {
    const [launches, stations, military, constellations] = await Promise.all([
      getRecentLaunches(),
      getStationData(),
      getMilitaryCount(),
      getConstellationStats(),
    ]);

    const hasData = !launches.error || !stations.error;

    if (!hasData) {
      return {
        source: 'Space/Satellites',
        timestamp: new Date().toISOString(),
        status: 'error',
        error: launches.error || stations.error || 'Failed to fetch space data',
      };
    }

    const data = { launches, stations, military, constellations };
    const signals = generateSignals(data);

    return {
      source: 'Space/Satellites',
      timestamp: new Date().toISOString(),
      status: 'active',
      recentLaunches: launches.recentLaunches || [],
      totalNewObjects: launches.totalObjects || 0,
      launchByCountry: launches.byCountry || {},
      spaceStations: stations.stations || [],
      iss: stations.iss || null,
      militarySatellites: military.count || 0,
      militaryByCountry: military.byCountry || {},
      constellations: constellations || {},
      signals,
    };
  } catch (e) {
    return {
      source: 'Space/Satellites',
      timestamp: new Date().toISOString(),
      status: 'error',
      error: e.message,
    };
  }
}

if (process.argv[1]?.endsWith('space.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
