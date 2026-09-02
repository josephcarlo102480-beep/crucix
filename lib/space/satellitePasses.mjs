// Server-side satellite pass context for Ask AI and diagnostics.
// Mirrors the browser satellite tracker's observer and pass logic.
//
// Elements come from services/space/tleCatalog.mjs — the same cached CelesTrak
// catalogue the tracker UI uses. (The old tle.ivanstanojevic.me API is dead.)

import * as satellite from 'satellite.js';
import { getGroup, search } from '../../services/space/tleCatalog.mjs';

const TLE_MAX_AGE_DAYS = 14;
const DEFAULT_HOURS_AHEAD = 12;
const STEP_SECONDS = 60;
const MIN_PASS_ELEVATION_DEG = 5;

// Propagating every category over 12h takes ~4s, and the route had no caching
// at all. Elements barely move in ten minutes, so serve a recent answer.
const PASS_CACHE_TTL_MS = 10 * 60 * 1000;
const PASS_CACHE_MAX_ENTRIES = 32;

const OBSERVERS_BY_ZIP = {
  '70443': { zip: '70443', label: 'Independence, LA', lat: 30.5155, lng: -90.5063 },
};

const DEFAULT_OBSERVER = OBSERVERS_BY_ZIP['70443'];

/** ZIPs with a real observer. Anything else falls back to DEFAULT_OBSERVER. */
export const KNOWN_ZIPS = Object.keys(OBSERVERS_BY_ZIP);

// Each category maps onto a tleCatalog group (or a free-text search).
const CATEGORIES = {
  iss:      { color: '#ffffff', group: 'stations', limit: 0, noradIds: [25544] },
  meteor:   { color: '#00e5ff', search: 'METEOR-M', limit: 20 },
  starlink: { color: '#4488ff', group: 'starlink', limit: 100 },
  oneweb:   { color: '#69f0ae', group: 'oneweb', limit: 100 },
  gps:      { color: '#ff9800', group: 'gnss', limit: 30 },
  military: { color: '#ff5f63', group: 'military', limit: 30 },
};

const passCache = new Map(); // cacheKey -> { expiresAt, value }

export function questionNeedsSatellitePassContext(question = '') {
  return /\b(satellites?|iss|starlink|oneweb|gps|meteor(?:-m)?|orbital|overhead|visible pass|sky)\b/i.test(String(question));
}

/**
 * Resolve a ZIP (or any text containing one) to an observer.
 * @returns {{ observer: object, matched: boolean, requestedZip: string|null }}
 *   `matched` is false when the default observer was substituted — callers
 *   need to know the answer is not about the place that was asked for.
 */
export function resolveObserver(zip = '') {
  const requestedZip = String(zip ?? '').match(/\b\d{5}\b/)?.[0] || null;
  const found = requestedZip ? OBSERVERS_BY_ZIP[requestedZip] : null;
  return {
    observer: found || DEFAULT_OBSERVER,
    matched: Boolean(found),
    requestedZip,
  };
}

export function observerForQuestion(question = '') {
  return resolveObserver(question).observer;
}

/**
 * @param {string} question  question text, or a bare ZIP from the route
 * @param {object} [opts]
 * @param {object} [opts.observer]   explicit observer, bypasses ZIP resolution
 * @param {number} [opts.hoursAhead]
 * @param {Date}   [opts.now]        fixed clock (disables caching)
 * @param {string[]} [opts.categories]
 * @param {(category: string, def: object) => Promise<object[]>} [opts.loadTles]
 *        element loader; defaults to the shared TLE catalogue (disables caching)
 * @param {boolean} [opts.cache=true]
 */
export async function getSatellitePassContext(question = '', opts = {}) {
  const resolved = opts.observer
    ? { observer: opts.observer, matched: true, requestedZip: opts.observer.zip ?? null }
    : resolveObserver(question);
  const { observer } = resolved;
  const hoursAhead = opts.hoursAhead || DEFAULT_HOURS_AHEAD;
  const categories = opts.categories || Object.keys(CATEGORIES);
  const loadTles = opts.loadTles || defaultLoadTles;

  // Only the standard, wall-clock computation is cacheable; an injected clock
  // or loader means the caller wants an exact, reproducible answer.
  const cacheable = opts.cache !== false && !opts.now && !opts.loadTles;
  const cacheKey = `${observer.lat},${observer.lng}|${hoursAhead}|${categories.join(',')}`;
  if (cacheable) {
    const hit = passCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const now = opts.now || new Date();
  const loaded = [];
  const errors = [];

  // One slow or failing category must not sink the rest.
  const settled = await Promise.allSettled(
    categories.map(category => loadCategory(category, loadTles)),
  );
  settled.forEach((outcome, i) => {
    const category = categories[i];
    if (outcome.status === 'fulfilled') loaded.push({ category, satrecs: outcome.value });
    else errors.push({ category, error: outcome.reason?.message || String(outcome.reason) });
  });

  const currentAboveHorizon = [];
  const passes = [];
  for (const { category, satrecs } of loaded) {
    const cat = CATEGORIES[category] || {};
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

  const result = {
    source: 'Crucix satellite tracker TLE pass calculation',
    generatedAt: new Date().toISOString(),
    now: now.toISOString(),
    observer: { ...observer, matched: resolved.matched, requestedZip: resolved.requestedZip },
    definition: `Geometric above-horizon passes over ${MIN_PASS_ELEVATION_DEG} degrees; optical naked-eye visibility still depends on darkness, clouds, and satellite brightness.`,
    categoriesChecked: categories,
    currentAboveHorizon: currentAboveHorizon.slice(0, 12),
    upcomingPasses: passes.slice(0, 30),
    errors,
  };

  if (cacheable) rememberPasses(cacheKey, result);
  return result;
}

function rememberPasses(cacheKey, value) {
  const now = Date.now();
  for (const [key, entry] of passCache) {
    if (entry.expiresAt <= now) passCache.delete(key);
  }
  if (passCache.size >= PASS_CACHE_MAX_ENTRIES) {
    passCache.delete(passCache.keys().next().value);
  }
  passCache.set(cacheKey, { expiresAt: now + PASS_CACHE_TTL_MS, value });
}

/** Drop every cached pass computation (tests, and any manual refresh). */
export function clearSatellitePassCache() {
  passCache.clear();
}

async function loadCategory(category, loadTles) {
  const def = CATEGORIES[category];
  if (!def) throw new Error(`unknown satellite category: ${category}`);
  const tles = await loadTles(category, def);
  return tlesToSatrecs(normalizeTles(tles));
}

/** Pull a category's elements from the shared TLE catalogue. */
async function defaultLoadTles(category, def) {
  if (def.search) {
    const res = await search(def.search, def.limit);
    return res?.sats || [];
  }

  const res = await getGroup(def.group, def.limit ?? 0);
  const sats = res?.sats || [];
  return def.noradIds ? sats.filter(sat => def.noradIds.includes(sat.id ?? sat.satelliteId)) : sats;
}

/** Catalogue records use `id`; the pass formatter expects `satelliteId`. */
function normalizeTles(tles) {
  return (tles || [])
    .filter(tle => tle && tle.line1 && tle.line2)
    .map(tle => ({
      name: tle.name || 'Unknown',
      satelliteId: tle.satelliteId ?? tle.id ?? null,
      line1: tle.line1,
      line2: tle.line2,
    }));
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
