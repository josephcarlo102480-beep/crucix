// Server-side satellite pass context for Ask AI and diagnostics.
// Mirrors the browser satellite tracker's observer and pass logic.

import * as satellite from 'satellite.js';
import { safeFetch } from '../../apis/utils/fetch.mjs';

const TLE_API = 'https://tle.ivanstanojevic.me/api/tle';
const TLE_MAX_AGE_DAYS = 14;
const DEFAULT_HOURS_AHEAD = 12;
const STEP_SECONDS = 60;
const MIN_PASS_ELEVATION_DEG = 5;

const OBSERVERS_BY_ZIP = {
  '70443': { zip: '70443', label: 'Independence, LA', lat: 30.5155, lng: -90.5063 },
};

const DEFAULT_OBSERVER = OBSERVERS_BY_ZIP['70443'];

const CATEGORIES = {
  iss: { noradId: 25544, color: '#ffffff' },
  starlink: { query: 'starlink', pageSize: 100, color: '#4488ff' },
  oneweb: { query: 'oneweb', pageSize: 100, color: '#69f0ae' },
  gps: { query: 'GPS', pageSize: 30, color: '#ff9800' },
  military: { queries: ['USA', 'NOSS', 'COSMOS'], pageSize: 15, maxTotal: 30, color: '#ff5f63' },
};

export function questionNeedsSatellitePassContext(question = '') {
  return /\b(satellites?|iss|starlink|oneweb|gps|orbital|overhead|visible pass|sky)\b/i.test(String(question));
}

export function observerForQuestion(question = '') {
  const zip = String(question).match(/\b\d{5}\b/)?.[0];
  return OBSERVERS_BY_ZIP[zip] || DEFAULT_OBSERVER;
}

export async function getSatellitePassContext(question = '', opts = {}) {
  const observer = opts.observer || observerForQuestion(question);
  const hoursAhead = opts.hoursAhead || DEFAULT_HOURS_AHEAD;
  const now = opts.now || new Date();
  const categories = opts.categories || Object.keys(CATEGORIES);
  const loaded = [];
  const errors = [];

  for (const category of categories) {
    try {
      const tles = await fetchCategoryTles(category);
      const satrecs = tlesToSatrecs(tles);
      loaded.push({ category, satrecs });
    } catch (err) {
      errors.push({ category, error: err?.message || String(err) });
    }
  }

  const currentAboveHorizon = [];
  const passes = [];
  for (const { category, satrecs } of loaded) {
    const cat = CATEGORIES[category];
    for (const { satrec, tle } of satrecs) {
      if (!isLowEarthOrbit(satrec)) continue;

      const currentLook = computeLookAngles(satrec, now, observer);
      if (currentLook?.elevation > MIN_PASS_ELEVATION_DEG) {
        currentAboveHorizon.push({
          name: tle.name || 'Unknown',
          noradId: tle.satelliteId,
          category,
          elevationDeg: round(currentLook.elevation, 1),
          azimuthDeg: round(normalizeAz(currentLook.azimuth), 1),
          bearing: azToBearing(currentLook.azimuth),
          rangeKm: round(currentLook.range, 0),
        });
      }

      passes.push(...computePassesForSat({ satrec, tle, category, color: cat.color, observer, now, hoursAhead }));
    }
  }

  passes.sort((a, b) => new Date(a.maxElTime) - new Date(b.maxElTime));
  currentAboveHorizon.sort((a, b) => b.elevationDeg - a.elevationDeg);

  return {
    source: 'Crucix satellite tracker TLE pass calculation',
    generatedAt: new Date().toISOString(),
    now: now.toISOString(),
    observer,
    definition: `Geometric above-horizon passes over ${MIN_PASS_ELEVATION_DEG} degrees; optical naked-eye visibility still depends on darkness, clouds, and satellite brightness.`,
    categoriesChecked: categories,
    currentAboveHorizon: currentAboveHorizon.slice(0, 12),
    upcomingPasses: passes.slice(0, 30),
    errors,
  };
}

async function fetchCategoryTles(category) {
  const cat = CATEGORIES[category];
  if (!cat) return [];

  if (cat.noradId) {
    const data = await safeFetch(`${TLE_API}/${cat.noradId}`, { timeout: 15000 });
    if (data?.error) throw new Error(data.error);
    return data?.line1 && data?.line2 ? [data] : [];
  }

  if (cat.queries) {
    const seen = new Set();
    const combined = [];
    for (const query of cat.queries) {
      const tles = await searchTles(query, cat.pageSize);
      for (const tle of tles) {
        const key = String(tle.satelliteId || tle.name || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        combined.push(tle);
        if (combined.length >= (cat.maxTotal || 30)) return combined;
      }
    }
    return combined;
  }

  return searchTles(cat.query, cat.pageSize);
}

async function searchTles(query, pageSize) {
  const url = `${TLE_API}/?search=${encodeURIComponent(query)}&page_size=${pageSize}`;
  const data = await safeFetch(url, { timeout: 20000 });
  if (data?.error) throw new Error(data.error);
  return (data?.member || []).filter(tle => tle.line1 && tle.line2 && isTleFresh(tle));
}

function tlesToSatrecs(tles) {
  const maxAge = TLE_MAX_AGE_DAYS * 86400000;
  const satrecs = [];

  for (const tle of tles) {
    try {
      const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      const epochMs = (satrec.jdsatepoch - 2440587.5) * 86400000;
      if (Number.isFinite(epochMs) && Date.now() - epochMs > maxAge) continue;
      satrecs.push({ satrec, tle });
    } catch {
      // Skip invalid TLEs.
    }
  }

  return satrecs;
}

function isLowEarthOrbit(satrec) {
  const periodMin = 2 * Math.PI / satrec.no;
  return Number.isFinite(periodMin) && periodMin <= 128;
}

function computePassesForSat({ satrec, tle, category, color, observer, now, hoursAhead }) {
  const passes = [];
  let inPass = false;
  let passMaxEl = 0;
  let passMaxElTime = null;
  let passMaxElAz = 0;
  let riseTime = null;
  let riseAz = 0;
  let setTime = null;
  let setAz = 0;

  for (let t = 0; t <= hoursAhead * 3600; t += STEP_SECONDS) {
    const time = new Date(now.getTime() + t * 1000);
    const look = computeLookAngles(satrec, time, observer);
    if (!look) continue;

    if (look.elevation > 0) {
      if (!inPass) {
        inPass = true;
        passMaxEl = 0;
        riseTime = time;
        riseAz = look.azimuth;
      }
      if (look.elevation > passMaxEl) {
        passMaxEl = look.elevation;
        passMaxElTime = time;
        passMaxElAz = look.azimuth;
      }
    } else if (inPass) {
      setTime = time;
      setAz = look.azimuth;
      if (passMaxEl > MIN_PASS_ELEVATION_DEG) {
        passes.push(formatPass({ tle, category, color, riseTime, riseAz, setTime, setAz, passMaxElTime, passMaxEl, passMaxElAz }));
      }
      inPass = false;
    }
  }

  if (inPass && passMaxEl > MIN_PASS_ELEVATION_DEG) {
    passes.push(formatPass({ tle, category, color, riseTime, riseAz, setTime: null, setAz: null, passMaxElTime, passMaxEl, passMaxElAz }));
  }

  return passes;
}

function formatPass({ tle, category, color, riseTime, riseAz, setTime, setAz, passMaxElTime, passMaxEl, passMaxElAz }) {
  return {
    name: tle.name || 'Unknown',
    noradId: tle.satelliteId,
    category,
    color,
    riseTime: riseTime?.toISOString() || null,
    riseBearing: azToBearing(riseAz),
    riseAzimuthDeg: round(normalizeAz(riseAz), 1),
    setTime: setTime?.toISOString() || null,
    setBearing: setAz == null ? 'ongoing' : azToBearing(setAz),
    setAzimuthDeg: setAz == null ? null : round(normalizeAz(setAz), 1),
    maxElTime: passMaxElTime?.toISOString() || null,
    maxElevationDeg: round(passMaxEl, 1),
    peakBearing: azToBearing(passMaxElAz),
    peakAzimuthDeg: round(normalizeAz(passMaxElAz), 1),
    overhead: passMaxEl > 60,
  };
}

function computeLookAngles(satrec, time, observer) {
  try {
    const posVel = satellite.propagate(satrec, time);
    if (!posVel || !posVel.position || typeof posVel.position === 'boolean') return null;
    if (satrec.error !== 0) return null;
    const p = posVel.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;

    const gmst = satellite.gstime(time);
    const ecf = satellite.eciToEcf(p, gmst);
    const look = satellite.ecfToLookAngles({
      longitude: satellite.degreesToRadians(observer.lng),
      latitude: satellite.degreesToRadians(observer.lat),
      height: 0.01,
    }, ecf);
    const azimuth = satellite.radiansToDegrees(look.azimuth);
    const elevation = satellite.radiansToDegrees(look.elevation);
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) return null;
    return { azimuth, elevation, range: look.rangeSat };
  } catch {
    return null;
  }
}

function isTleFresh(tle) {
  const maxAge = TLE_MAX_AGE_DAYS * 86400000;
  if (tle.date) {
    const ageMs = Date.now() - new Date(tle.date).getTime();
    return Number.isFinite(ageMs) && ageMs < maxAge;
  }
  if (tle.line1) {
    const epoch = tleEpochToDate(tle.line1);
    if (epoch) return Date.now() - epoch.getTime() < maxAge;
  }
  return false;
}

function tleEpochToDate(line1) {
  try {
    const epochStr = line1.substring(18, 32).trim();
    const yy = Number.parseInt(epochStr.substring(0, 2), 10);
    const ddd = Number.parseFloat(epochStr.substring(2));
    if (!Number.isFinite(yy) || !Number.isFinite(ddd)) return null;
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const jan1 = new Date(Date.UTC(year, 0, 1));
    return new Date(jan1.getTime() + (ddd - 1) * 86400000);
  } catch {
    return null;
  }
}

function azToBearing(azDeg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(normalizeAz(azDeg) / 22.5) % 16];
}

function normalizeAz(azDeg) {
  return ((azDeg % 360) + 360) % 360;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
