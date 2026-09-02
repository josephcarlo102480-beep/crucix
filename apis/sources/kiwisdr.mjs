// KiwiSDR Network — Global software-defined radio receiver network
// No auth required. ~900 public HF receivers worldwide (0-30 MHz).
// Useful for SIGINT awareness: receiver distribution and coverage of conflict
// zones. Data source: receiverbook.de (embeds the receiver list as a JS var).
//
// What this feed does NOT carry: connected-user counts, per-receiver capacity,
// SNR, TDOA capability or an online/offline flag. Earlier revisions declared
// those fields anyway, hardcoded to 0/NaN/null/false, which produced a
// utilisation panel that was structurally 0% and three signals that could
// never fire. Rather than publish zeros that look measured, the metrics that
// the feed cannot support are simply absent.

import { safeFetch } from '../utils/fetch.mjs';

const RECEIVERBOOK_URL = 'https://www.receiverbook.de/map?type=kiwisdr';

// Fetch the full list of public KiwiSDR receivers from receiverbook.de.
// Resolves to an array of receivers or `{ error }`.
export async function getAllReceivers(opts = {}) {
  const res = await safeFetch(RECEIVERBOOK_URL, {
    timeout: 20000,
    retries: 0,
    responseType: 'text',
    signal: opts.signal,
  });
  if (res?.error) return { error: res.error };

  // Extract embedded JS: var receivers = [...];
  const match = String(res?.text || '').match(/var\s+receivers\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return { error: 'Could not parse receiver data from receiverbook page' };

  let sites;
  try {
    sites = JSON.parse(match[1]);
  } catch (e) {
    return { error: `Receiver list is not valid JSON: ${e.message}` };
  }
  if (!Array.isArray(sites)) return { error: 'Receiver list was not an array' };

  // Flatten: each site has a .receivers[] array of individual SDRs
  const flat = [];
  for (const site of sites) {
    const [lon, lat] = site.location?.coordinates || [NaN, NaN];
    // Labels read "0-30 MHz SDR | Doha, Qatar" — the country is the last
    // segment after either separator, not just after a comma.
    const country = site.label?.split(/[,|]/).pop()?.trim() || '';
    for (const rx of (site.receivers || [site])) {
      flat.push({
        name: rx.label || site.label || '',
        location: site.label || '',
        lat, lon,
        country,
        url: rx.url || site.url || '',
        version: rx.version || '',
      });
    }
  }
  if (!flat.length) return { error: 'Receiverbook page contained no receivers' };
  return flat;
}

// Regions of intelligence interest with bounding boxes
const REGIONS_OF_INTEREST = {
  middleEast:     { lamin: 12, lomin: 30, lamax: 42, lomax: 65, label: 'Middle East' },
  ukraine:        { lamin: 44, lomin: 22, lamax: 53, lomax: 41, label: 'Ukraine / Eastern Europe' },
  taiwan:         { lamin: 20, lomin: 115, lamax: 28, lomax: 125, label: 'Taiwan Strait' },
  baltics:        { lamin: 53, lomin: 19, lamax: 60, lomax: 29, label: 'Baltic Region' },
  southChinaSea:  { lamin: 5, lomin: 105, lamax: 23, lomax: 122, label: 'South China Sea' },
  koreanPeninsula:{ lamin: 33, lomin: 124, lamax: 43, lomax: 132, label: 'Korean Peninsula' },
  iran:           { lamin: 25, lomin: 44, lamax: 40, lomax: 63, label: 'Iran' },
  sahel:          { lamin: 10, lomin: -17, lamax: 20, lomax: 25, label: 'Sahel / West Africa' },
};

// Check if a receiver falls within a bounding box
function inBounds(rx, box) {
  if (isNaN(rx.lat) || isNaN(rx.lon)) return false;
  return rx.lat >= box.lamin && rx.lat <= box.lamax && rx.lon >= box.lomin && rx.lon <= box.lomax;
}

// Map a receiver to a continent based on coordinates
function getContinent(lat, lon) {
  if (isNaN(lat) || isNaN(lon)) return 'Unknown';
  if (lat >= 15 && lat <= 72 && lon >= -170 && lon <= -50) return 'North America';
  if (lat >= -60 && lat < 15 && lon >= -90 && lon <= -30) return 'South America';
  if (lat >= 35 && lat <= 72 && lon >= -25 && lon <= 45) return 'Europe';
  if (lat >= -35 && lat <= 37 && lon >= -25 && lon <= 55) return 'Africa';
  if (lat >= 0 && lat <= 72 && lon >= 45 && lon <= 180) return 'Asia';
  if (lat >= -50 && lat <= 0 && lon >= 95 && lon <= 180) return 'Oceania';
  if (lat >= 35 && lat < 45 && lon >= 25 && lon <= 45) return 'Middle East';
  return 'Other';
}

// Normalize receiver data (already flat from getAllReceivers)
function normalizeReceiver(rx, idx) {
  return {
    name: (rx.name || `Receiver-${idx}`).slice(0, 100),
    location: (rx.location || '').slice(0, 80),
    lat: parseFloat(rx.lat) || NaN,
    lon: parseFloat(rx.lon) || NaN,
    country: rx.country || '',
    url: rx.url || '',
  };
}

// Briefing — analyze the global KiwiSDR network
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const raw = await getAllReceivers({ signal });

  if (!Array.isArray(raw)) {
    return {
      source: 'KiwiSDR',
      timestamp: new Date().toISOString(),
      status: 'error',
      error: raw?.error || 'KiwiSDR receiver list unavailable',
      message: raw?.error || 'KiwiSDR receiver list unavailable',
      network: { totalReceivers: 0, online: 0 },
      geographic: { byContinent: {}, topCountries: [] },
      conflictZones: {},
      signals: [],
    };
  }

  const allRx = raw.map((rx, i) => normalizeReceiver(rx, i));
  // Receiverbook only lists receivers it considers publicly reachable; it does
  // not publish a liveness flag, so "online" means "currently listed".
  const listedRx = allRx;

  // --- Geographic distribution by country ---
  const byCountry = {};
  for (const rx of listedRx) {
    const c = rx.country || 'Unknown';
    byCountry[c] = (byCountry[c] || 0) + 1;
  }
  const topCountries = Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([country, count]) => ({ country, count }));

  // --- Continental distribution ---
  const byContinent = {};
  for (const rx of listedRx) {
    const continent = getContinent(rx.lat, rx.lon);
    byContinent[continent] = (byContinent[continent] || 0) + 1;
  }

  // --- Receivers in regions of interest ---
  const conflictZoneReceivers = {};
  for (const [key, box] of Object.entries(REGIONS_OF_INTEREST)) {
    const rxInRegion = listedRx.filter(rx => inBounds(rx, box));
    conflictZoneReceivers[key] = {
      region: box.label,
      count: rxInRegion.length,
      receivers: rxInRegion.slice(0, 10).map(rx => ({
        name: rx.name,
        location: rx.location,
        lat: rx.lat,
        lon: rx.lon,
        country: rx.country,
      })),
    };
  }

  // --- Signals ---
  // Coverage gaps are the only thing this feed can honestly assert. A conflict
  // zone with no public receiver is a real observability blind spot; listener
  // activity is not observable here at all.
  const signals = [];
  for (const info of Object.values(conflictZoneReceivers)) {
    if (info.count === 0) {
      signals.push(`NO SDR COVERAGE in ${info.region} — no public KiwiSDR receiver in the region`);
    }
  }

  return {
    source: 'KiwiSDR',
    timestamp: new Date().toISOString(),
    status: 'active',
    network: {
      totalReceivers: allRx.length,
      online: listedRx.length,
    },
    geographic: {
      byContinent,
      topCountries,
    },
    conflictZones: conflictZoneReceivers,
    signals,
    note: 'receiverbook.de publishes receiver locations only — connected users, capacity, SNR and TDOA capability are not available from this feed.',
  };
}

if (process.argv[1]?.endsWith('kiwisdr.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
