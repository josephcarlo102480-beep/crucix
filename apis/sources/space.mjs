// Space / Satellite Activity Monitoring
//
// Elements come from services/space/tleCatalog.mjs — the same cached CelesTrak
// catalogue the tracker UI and the Ask-AI pass predictor use — so a sweep costs
// no upstream requests of its own. (The old tle.ivanstanojevic.me API is dead.)
//
// Tracks: last-30-day launches, ISS + stations with orbit geometry, military
// constellation size, Starlink/OneWeb counts.
//
// The one thing the catalogue cannot serve is CelesTrak's "last 30 days'
// launches" list: that group answers FORMAT=json but 404s in TLE format. It
// is fetched here as JSON (OMM fields, no TLE lines) and held for the same
// 2.5 h window the catalogue uses, so a 15-minute sweep never re-asks.

import { getGroup } from '../../services/space/tleCatalog.mjs';
import { safeFetch } from '../utils/fetch.mjs';

const RECENT_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json';
const RECENT_TTL_MS = 2.5 * 60 * 60 * 1000;
const RECENT_RETRY_MS = 15 * 60 * 1000;

const EARTH_RADIUS_KM = 6371.0;
const MU_KM3_S2 = 398600.4418;

/** Orbit geometry from Keplerian elements (mean motion in rev/day). */
export function orbitFromElements({ meanMotion, eccentricity, inclination }) {
  if (![inclination, eccentricity, meanMotion].every(Number.isFinite) || meanMotion <= 0) return null;
  const n = (meanMotion * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU_KM3_S2 / (n * n)); // semi-major axis, km
  const apogee = a * (1 + eccentricity) - EARTH_RADIUS_KM;
  const perigee = a * (1 - eccentricity) - EARTH_RADIUS_KM;
  return {
    inclination: +inclination.toFixed(2),
    eccentricity: +eccentricity.toFixed(6),
    periodMin: +(1440 / meanMotion).toFixed(1),
    apogee: +apogee.toFixed(0),
    perigee: +perigee.toFixed(0),
    altitudeKm: +((apogee + perigee) / 2).toFixed(0),
  };
}

/**
 * Orbit geometry straight from TLE line 2: inclination (cols 9-16),
 * eccentricity (cols 27-33, implied leading "0."), mean motion (cols 53-63,
 * rev/day). Returns null when the line does not parse.
 */
export function orbitFromTle(line2) {
  if (typeof line2 !== 'string' || line2.length < 63) return null;
  return orbitFromElements({
    inclination: Number.parseFloat(line2.slice(8, 16)),
    eccentricity: Number.parseFloat(`0.${line2.slice(26, 33).trim()}`),
    meanMotion: Number.parseFloat(line2.slice(52, 63)),
  });
}

/**
 * International designator → launch id + year. Accepts the TLE form
 * (YYNNNPPP, line 1 cols 10-17) and the OMM OBJECT_ID form (YYYY-NNNPPP).
 */
export function launchFromDesignator(desig) {
  const d = String(desig || '').trim();
  let m = /^(\d{4})-(\d{3})([A-Z]{0,3})$/.exec(d);
  if (m) return { designator: d, launchId: `${m[1]}-${m[2]}`, year: Number(m[1]), piece: m[3] || '' };
  m = /^(\d{2})(\d{3})([A-Z]{0,3})$/.exec(d);
  if (!m) return null;
  const yy = Number.parseInt(m[1], 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return { designator: d, launchId: `${year}-${m[2]}`, year, piece: m[3] || '' };
}

/** International designator from TLE line 1. */
export function launchFromTle(line1) {
  if (typeof line1 !== 'string' || line1.length < 17) return null;
  return launchFromDesignator(line1.slice(9, 17));
}

// Operator attribution from the catalogue name. An approximation — the TLE
// carries no ownership field — but good enough for a by-country rollup.
const COUNTRY_RULES = [
  ['US', /^(USA[ -]|NOSS |NROL|GSSAP|SBIRS|AEHF|WGS |MUOS|MILSTAR|DSP |STARLINK|GPS |NAVSTAR|GOES|TDRS|ORION |INTRUDER|MENTOR|TRUMPET|TOPAZ|LACROSSE|ONYX|IRIDIUM|GLOBALSTAR|KUIPER|PLANET|FLOCK|SKYSAT|LEMUR|SPIRE|CAPELLA|BLACKSKY|MAXAR|WORLDVIEW|LANDSAT|NOAA|TRANSPORTER|BANDWAGON|ORBCOMM|DIRECTV|SES-|INTELSAT|VIASAT|ECHOSTAR|NUSAT)/i],
  ['CIS', /^(COSMOS|KOSMOS|GLONASS|SOYUZ|PROGRESS|METEOR-M|RESURS|EXPRESS|YAMAL|GONETS|BARS|LOTOS|TUNDRA|EKS|ARKTIKA)/i],
  ['PRC', /^(CZ-|YAOGAN|SHIJIAN|SHIYAN|BEIDOU|TIANGONG|TIANZHOU|SHENZHOU|TIANHUI|TIANLIAN|GAOFEN|JILIN|QIANFAN|GUOWANG|HULIANWANG|TJS|LUDI TANCE|HAIYANG|FENGYUN|ZHUHAI|XW-|CSS |TIANQI|SHENTU|GEELY|CHINASAT|ZHONGXING|YUNHAI|XINGYUN|APSTAR|TIANMU|SATNET)/i],
  ['EU', /^(GALILEO|SENTINEL|METOP|METEOSAT|EUTELSAT|ONEWEB|CSO-|HELIOS|PLEIADES|SAR-LUPE|SARAH|COSMO-SKYMED|SICRAL|CERES|SYRACUSE|SKYNET|OFEQ|ARIANE|VEGA|ASTRA|HOTBIRD|IRIDE|KOMPSAT-)/i],
  ['IND', /^(CARTOSAT|RISAT|GSAT|IRNSS|NAVIC|EOS-|PSLV|INSAT|RESOURCESAT|OCEANSAT|NISAR)/i],
  ['JPN', /^(HIMAWARI|QZS|ALOS|IGS |GOSAT|MICHIBIKI|H-2A|H3|JCSAT|SUPERBIRD|DAICHI)/i],
  ['KOR', /^(KOMPSAT|CAS500|KSLV|NURI|KOREASAT|CHOLLIAN)/i],
  ['IRN', /^(NOOR|KHAYYAM|SOLJAR|CHAMRAN|KOWSAR|HODHOD|PARS)/i],
  ['PRK', /^(KMS|MALLIGYONG|KWANGMYONGSONG)/i],
];

export function countryFromName(name) {
  const n = String(name || '').trim();
  for (const [code, re] of COUNTRY_RULES) if (re.test(n)) return code;
  return 'OTHER';
}

function countBy(list, keyFn) {
  const out = {};
  for (const item of list) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function describe(sat) {
  const orbit = orbitFromTle(sat.line2) || {};
  const launch = launchFromTle(sat.line1) || {};
  return {
    name: sat.name,
    noradId: sat.id ?? sat.satelliteId ?? null,
    line1: sat.line1,
    line2: sat.line2,
    epoch: Number.isFinite(sat.epoch) ? new Date(sat.epoch).toISOString() : undefined,
    country: countryFromName(sat.name),
    launchId: launch.launchId,
    ...orbit,
  };
}

/** One CelesTrak OMM record → the same shape describe() gives a TLE. */
function describeOmm(rec) {
  const orbit = orbitFromElements({
    meanMotion: Number(rec.MEAN_MOTION),
    eccentricity: Number(rec.ECCENTRICITY),
    inclination: Number(rec.INCLINATION),
  }) || {};
  const launch = launchFromDesignator(rec.OBJECT_ID) || {};
  return {
    name: rec.OBJECT_NAME,
    noradId: Number.isFinite(Number(rec.NORAD_CAT_ID)) ? Number(rec.NORAD_CAT_ID) : null,
    epoch: rec.EPOCH ? new Date(`${rec.EPOCH}Z`).toISOString() : undefined,
    country: countryFromName(rec.OBJECT_NAME),
    launchId: launch.launchId,
    ...orbit,
  };
}

let recentCache = null; // { fetchedAt, sats }
let recentNextAttemptAt = 0;

/**
 * Last 30 days' launches as OMM JSON, cached for RECENT_TTL_MS. A failed
 * refresh keeps serving the previous list (flagged stale) and waits
 * RECENT_RETRY_MS before asking again, so CelesTrak is never hammered.
 */
async function loadRecent({ signal, fetchImpl = safeFetch } = {}) {
  const now = Date.now();
  if (recentCache && now - recentCache.fetchedAt < RECENT_TTL_MS) return { sats: recentCache.sats, stale: false };
  if (now < recentNextAttemptAt) return recentCache ? { sats: recentCache.sats, stale: true } : { sats: [], error: 'recent launches: waiting out backoff' };

  const res = await fetchImpl(RECENT_URL, { timeout: 20000, retries: 0, signal });
  if (!Array.isArray(res)) {
    recentNextAttemptAt = now + RECENT_RETRY_MS;
    const error = `recent launches: ${res?.error || (res?.rawText ? `non-JSON body "${String(res.rawText).slice(0, 60)}"` : 'unexpected payload')}`;
    return recentCache ? { sats: recentCache.sats, stale: true, error } : { sats: [], error };
  }
  const sats = res.filter(r => r && r.OBJECT_NAME).map(describeOmm);
  recentCache = { fetchedAt: now, sats };
  recentNextAttemptAt = 0;
  return { sats, stale: false };
}

/** Test hook: forget the cached recent-launch list. */
export function clearRecentLaunchCache() {
  recentCache = null;
  recentNextAttemptAt = 0;
}

/** Load a catalogue group; a failure becomes `{ error }` rather than a throw. */
async function loadAll(groupId, loadGroup) {
  try {
    const res = await loadGroup(groupId, 0);
    return { sats: res?.sats || [], total: res?.total ?? (res?.sats || []).length, stale: Boolean(res?.stale), failures: res?.failures || [] };
  } catch (e) {
    return { sats: [], total: 0, stale: false, failures: [], error: e.message };
  }
}

function distinctLaunches(list) {
  return new Set(list.map(s => s.launchId).filter(Boolean)).size;
}

// Thresholds are per distinct launch, not per object: a single Starlink or
// Guowang flight orbits 20+ objects, so object counts would fire every sweep.
// ~20 launches/month is the 2026 baseline; 30 is a genuinely busy month.
function generateSignals({ recent, military }) {
  const signals = [];
  const launches = distinctLaunches(recent);
  if (launches >= 30) {
    signals.push(`HIGH LAUNCH TEMPO: ${launches} launches in the last 30 days (${recent.length} objects)`);
  }
  const prcLaunches = distinctLaunches(recent.filter(s => s.country === 'PRC'));
  if (prcLaunches >= 8) {
    signals.push(`CHINA SPACE ACTIVITY: ${prcLaunches} launches in the last 30 days`);
  }
  const cisLaunches = distinctLaunches(recent.filter(s => s.country === 'CIS'));
  if (cisLaunches >= 4) {
    signals.push(`RUSSIA SPACE ACTIVITY: ${cisLaunches} launches in the last 30 days`);
  }
  const recentMilitary = recent.filter(s => military.ids.has(s.noradId));
  if (recentMilitary.length) {
    signals.push(`NEW MILITARY OBJECTS: ${recentMilitary.slice(0, 4).map(s => s.name).join(', ')}${recentMilitary.length > 4 ? ` +${recentMilitary.length - 4}` : ''}`);
  }
  return signals;
}

// Briefing export. `opts.loadGroup` / `opts.fetchImpl` let tests stub the
// catalogue and the recent-launch fetch; runSource() passes `{ signal }`.
export async function briefing(opts = {}) {
  const loadGroup = typeof opts.loadGroup === 'function' ? opts.loadGroup : getGroup;
  const timestamp = new Date().toISOString();
  try {
    const [recentRes, stationRes, militaryRes, starlinkRes, onewebRes] = await Promise.all([
      loadRecent({ signal: opts.signal, fetchImpl: opts.fetchImpl }).catch(e => ({ sats: [], error: `recent launches: ${e.message}` })),
      loadAll('stations', loadGroup),
      loadAll('military', loadGroup),
      loadAll('starlink', loadGroup),
      loadAll('oneweb', loadGroup),
    ]);
    const groups = { stations: stationRes, military: militaryRes, starlink: starlinkRes, oneweb: onewebRes };
    const errors = [
      ...(recentRes.error ? [recentRes.error] : []),
      ...Object.entries(groups)
        .flatMap(([g, r]) => [...(r.error ? [`${g}: ${r.error}`] : []), ...r.failures.map(f => `${g}/${f.group}: ${f.error}`)]),
    ];

    if (recentRes.error && stationRes.error) {
      return { source: 'Space/Satellites', timestamp, status: 'error', error: errors.join('; ') || 'TLE catalogue unavailable' };
    }

    const recent = recentRes.sats.slice().sort((a, b) => (b.epoch || '').localeCompare(a.epoch || ''));
    const launchByCountry = countBy(recent, s => s.country);

    const stations = stationRes.sats.map(describe);
    const iss = stations.find(s => s.noradId === 25544) || stations.find(s => /^ISS/i.test(s.name)) || null;

    const military = { ids: new Set(militaryRes.sats.map(s => s.id)), sats: militaryRes.sats };
    const militaryByCountry = countBy(militaryRes.sats, s => countryFromName(s.name));

    const signals = generateSignals({ recent, military });
    const stale = Boolean(recentRes.stale) || Object.values(groups).some(r => r.stale);

    return {
      source: 'Space/Satellites',
      timestamp,
      status: 'active',
      recentLaunches: recent.slice(0, 25),
      totalNewObjects: recent.length,
      distinctLaunches: distinctLaunches(recent),
      launchByCountry,
      spaceStations: stations.filter(s => s.noradId !== iss?.noradId).slice(0, 10),
      totalStations: stationRes.total,
      iss,
      militarySatellites: militaryRes.total,
      militaryByCountry,
      constellations: { starlink: starlinkRes.total, oneweb: onewebRes.total },
      signals,
      ...(stale ? { stale: true } : {}),
      ...(errors.length ? { error: `Partial catalogue: ${errors.join('; ')}` } : {}),
    };
  } catch (e) {
    return { source: 'Space/Satellites', timestamp, status: 'error', error: e.message };
  }
}

if (process.argv[1]?.endsWith('space.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
