/**
 * TLE catalog — cached orbital elements from CelesTrak (Module: space).
 *
 * Why this exists: the browser tracker used to hit tle.ivanstanojevic.me
 * directly. That API caps `page_size` at 20, mixes in elements years out of
 * date, and answers HTTP 508 after two or three requests in a row — so a
 * multi-query category like "military" reliably came back empty.
 *
 * CelesTrak publishes whole constellations as one file, refreshed every two
 * hours, and answers in well under a second from here. We fetch per group,
 * cache in memory, and mirror to `data/tle/<group>.json` so a restart (or a
 * CelesTrak outage) still has elements to serve.
 *
 * CelesTrak enforces politeness with a 403 whose body reads "GP data has not
 * updated since your last successful download" — that is a *not-modified*,
 * not a failure, and the cached copy is the correct answer to it.
 *
 * Starlink and OneWeb come from the supplemental sets instead: those are
 * operator-supplied, more accurate than the general catalogue for those
 * shells, and rate-limited separately from the GROUP endpoint.
 *
 * The `active` group (~16k objects) is the search index and the source for
 * name-filtered pseudo-groups like `military`.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '..', 'data', 'tle');

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
const SUPPLEMENTAL = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';
const FETCH_TIMEOUT_MS = 30000;

// CelesTrak regenerates GP data every 2 h, so anything shorter is guaranteed
// to come back as a not-modified 403. A stale copy still propagates fine.
const TTL_MS = 2.5 * 60 * 60 * 1000;
// How long to sit on a not-modified before asking again.
const NOT_MODIFIED_BACKOFF_MS = 30 * 60 * 1000;
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Elements older than this propagate to garbage — SGP4 error grows fast.
const MAX_ELEMENT_AGE_DAYS = 21;

/**
 * Display groups offered to the tracker UI.
 *
 *   sources  — CelesTrak GROUP names, taken wholesale, concatenated in order
 *   mined    — GROUP names kept only where a name matches `match`
 *   cap      — default number of satellites served (UI can ask for more)
 */
export const GROUPS = {
  stations: {
    label: 'Stations & Crewed',
    sources: ['stations'],
    color: '#ffffff',
    cap: 40,
    blurb: 'ISS, Tiangong and co-orbiting vehicles',
  },
  visual: {
    label: 'Brightest / Visual',
    sources: ['visual'],
    color: '#ffe680',
    cap: 200,
    blurb: 'The objects actually visible to the naked eye',
  },
  weather: {
    label: 'Weather & Earth Obs',
    sources: ['weather', 'resource'],
    color: '#00e5ff',
    cap: 150,
    blurb: 'METEOR-M, NOAA, DMSP, imaging platforms',
  },
  military: {
    label: 'Military / Recon',
    sources: ['military'],
    mined: ['active'],
    // USA-xxx (NRO), NOSS naval ELINT pairs, Cosmos, Israeli Ofeq, Chinese
    // Yaogan/Shijian, German SAR-Lupe, Italian/French SAR birds.
    match: /^(USA[ -]|NOSS |COSMOS |KOSMOS |SAR-LUPE|OFEQ|YAOGAN|SHIJIAN|HELIOS|CSO-|PLEIADES|TOPAZ|LACROSSE|ONYX|MENTOR|TRUMPET|ORION |INTRUDER|GSSAP|SBIRS|AEHF|WGS |MUOS|MILSTAR|DSP |NROL)/i,
    color: '#ff5f63',
    cap: 250,
    blurb: 'Recon, ELINT and dedicated military comms',
  },
  starlink: {
    label: 'Starlink',
    sources: ['sup:starlink', 'starlink'],
    color: '#4488ff',
    cap: 600,
    blurb: 'SpaceX broadband shell (~550 km)',
  },
  oneweb: {
    label: 'OneWeb',
    sources: ['sup:oneweb', 'oneweb'],
    color: '#69f0ae',
    cap: 400,
    blurb: 'Eutelsat OneWeb polar shell (~1200 km)',
  },
  gnss: {
    label: 'GNSS',
    sources: ['gps-ops', 'galileo', 'beidou', 'glo-ops'],
    color: '#ff9800',
    cap: 160,
    blurb: 'GPS, Galileo, BeiDou and GLONASS',
  },
  geo: {
    label: 'Geostationary',
    sources: ['geo'],
    color: '#bb44ff',
    cap: 300,
    blurb: 'The 35 786 km belt',
  },
  science: {
    label: 'Science',
    sources: ['science', 'cubesat'],
    color: '#c0a0ff',
    cap: 150,
    blurb: 'Hubble, observatories, cubesats',
  },
};

const memory = new Map();   // celestrak group name -> { fetchedAt, sats }
const inFlight = new Map(); // celestrak group name -> Promise

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * TLE line 1 columns 19-32 hold the epoch as YYDDD.DDDDDDDD. Returning ms
 * rather than a Date keeps the per-satellite records small — there are 16k
 * of them in the `active` group.
 */
function epochMsFromLine1(line1) {
  const yy = Number.parseInt(line1.slice(18, 20), 10);
  const doy = Number.parseFloat(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(doy)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy; // standard TLE convention
  return Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
}

/** Checksum-free structural validation — enough to reject truncated payloads. */
function looksLikeTle(line1, line2) {
  return line1.startsWith('1 ') && line2.startsWith('2 ')
    && line1.length >= 68 && line2.length >= 68;
}

function parseTleText(text) {
  const lines = String(text).split(/\r?\n/);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i] || '').trim();
    const line1 = (lines[i + 1] || '').trimEnd();
    const line2 = (lines[i + 2] || '').trimEnd();
    if (!name || !looksLikeTle(line1, line2)) continue;
    const noradId = Number.parseInt(line1.slice(2, 7), 10);
    const epoch = epochMsFromLine1(line1);
    if (!Number.isFinite(noradId) || epoch === null) continue;
    sats.push({ id: noradId, name, line1, line2, epoch });
  }
  return sats;
}

/** `sup:starlink` → the supplemental endpoint; anything else → GROUP=. */
function sourceUrl(source) {
  return source.startsWith('sup:')
    ? `${SUPPLEMENTAL}?FILE=${encodeURIComponent(source.slice(4))}&FORMAT=tle`
    : `${CELESTRAK}?GROUP=${encodeURIComponent(source)}&FORMAT=tle`;
}

function cacheFile(source) {
  return join(CACHE_DIR, `${source.replace(/[^a-z0-9_-]+/gi, '-')}.json`);
}

function readDisk(source) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(source), 'utf8'));
    if (!Array.isArray(raw.sats) || !raw.sats.length) return null;
    if (Date.now() - raw.fetchedAt > DISK_MAX_AGE_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeDisk(source, entry) {
  try {
    ensureCacheDir();
    writeFileSync(cacheFile(source), JSON.stringify(entry));
  } catch (err) {
    console.warn(`[tle] could not cache ${source} to disk: ${err.message}`);
  }
}

const NOT_MODIFIED = Symbol('celestrak-not-modified');

async function fetchSourceText(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl(source), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Crucix/1.0 (satellite tracker)' },
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403 && /has not updated/i.test(text)) return NOT_MODIFIED;
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).trim()}`);
    }
    // CelesTrak answers 200 with a plain-text error for a bad group name.
    if (/Invalid query/i.test(text.slice(0, 200))) throw new Error(text.slice(0, 120).trim());
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one source, preferring memory → disk → network.
 * Entries carry `fetchedAt` (age of the elements) and `checkedAt` (when we
 * last asked upstream) so a not-modified can defer the next call without
 * pretending the data got any newer.
 */
async function loadGroup(source) {
  const cached = memory.get(source) || (() => {
    const disk = readDisk(source);
    if (disk) memory.set(source, disk);
    return disk;
  })();

  if (cached && Date.now() - (cached.checkedAt || cached.fetchedAt) < TTL_MS) return cached;
  if (inFlight.has(source)) return inFlight.get(source);

  const job = (async () => {
    try {
      const text = await fetchSourceText(source);
      if (text === NOT_MODIFIED) {
        if (!cached) {
          throw Object.assign(
            new Error('CelesTrak has no new data since our last download and nothing is cached yet'),
            { status: 503 },
          );
        }
        const held = { ...cached, checkedAt: Date.now() - TTL_MS + NOT_MODIFIED_BACKOFF_MS };
        memory.set(source, held);
        writeDisk(source, held);
        return held;
      }
      const sats = parseTleText(text);
      if (!sats.length) throw new Error('no elements parsed');
      const entry = { fetchedAt: Date.now(), checkedAt: Date.now(), sats, stale: false };
      memory.set(source, entry);
      writeDisk(source, entry);
      return entry;
    } catch (err) {
      // Serving hours-old elements beats serving nothing: SGP4 is still good
      // to a few km a day out. Only a total absence of data is an error.
      if (cached) {
        console.warn(`[tle] ${source} refresh failed (${err.message}), serving cached copy`);
        const stale = { ...cached, checkedAt: Date.now(), stale: true };
        memory.set(source, stale);
        return stale;
      }
      throw err;
    } finally {
      inFlight.delete(source);
    }
  })();

  inFlight.set(source, job);
  return job;
}

function isUsable(sat, now) {
  return now - sat.epoch < MAX_ELEMENT_AGE_DAYS * 86400000;
}

/**
 * Resolve a display group to satellites, newest elements first.
 * `limit` of 0 means "everything the group has".
 */
export async function getGroup(groupId, limit) {
  const def = GROUPS[groupId];
  if (!def) throw Object.assign(new Error(`unknown group: ${groupId}`), { status: 404 });

  const now = Date.now();
  const seen = new Set();
  const sats = [];
  let fetchedAt = now;
  let stale = false;
  const failures = [];

  const sources = [
    ...def.sources.map((name) => ({ name, filter: false })),
    ...(def.mined || []).map((name) => ({ name, filter: true })),
  ];

  for (const { name: source, filter } of sources) {
    let entry;
    try {
      entry = await loadGroup(source);
    } catch (err) {
      failures.push(`${source}: ${err.message}`);
      continue;
    }
    fetchedAt = Math.min(fetchedAt, entry.fetchedAt);
    stale = stale || Boolean(entry.stale);
    for (const sat of entry.sats) {
      if (seen.has(sat.id) || !isUsable(sat, now)) continue;
      if (filter && def.match && !def.match.test(sat.name)) continue;
      seen.add(sat.id);
      sats.push(sat);
    }
  }

  if (!sats.length && failures.length) {
    throw Object.assign(new Error(failures.join('; ')), { status: 502 });
  }

  // Freshest elements first, so a cap keeps the most trustworthy objects.
  sats.sort((a, b) => b.epoch - a.epoch);
  const cap = limit === 0 ? sats.length : (limit || def.cap);
  const shown = sample(sats, cap);

  return {
    group: groupId,
    label: def.label,
    color: def.color,
    fetchedAt,
    stale,
    total: sats.length,
    count: shown.length,
    sats: shown,
  };
}

/**
 * Take `count` items spread evenly across the list rather than the first N.
 * Starlink's 10 000 objects arrive grouped by launch, so a plain slice draws
 * one clump of one orbital plane; a strided sample draws the whole shell.
 */
function sample(list, count) {
  if (count >= list.length) return list.slice();
  const stride = list.length / count;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(list[Math.floor(i * stride)]);
  return out;
}

/**
 * Free-text / NORAD-ID search. `active` is the real index; when CelesTrak is
 * holding it back the already-cached groups still answer, so search degrades
 * to "everything we know about" rather than to nothing.
 */
export async function search(query, limit = 40) {
  const q = String(query || '').trim();
  if (q.length < 2) return { query: q, count: 0, sats: [], scope: 'none' };

  let scope = 'catalog';
  let pool;
  try {
    pool = [(await loadGroup('active')).sats];
  } catch {
    scope = 'cached';
    pool = [...memory.values()].map((entry) => entry.sats);
    if (!pool.length) return { query: q, count: 0, sats: [], scope: 'unavailable' };
  }

  const now = Date.now();
  const numeric = /^\d{1,6}$/.test(q) ? Number.parseInt(q, 10) : null;
  const needle = q.toUpperCase();
  const seen = new Set();
  const hits = [];

  for (const sats of pool) {
    for (const sat of sats) {
      if (seen.has(sat.id) || !isUsable(sat, now)) continue;
      if (numeric !== null && sat.id === numeric) {
        seen.add(sat.id);
        hits.unshift(sat);
      } else if (sat.name.toUpperCase().includes(needle)) {
        seen.add(sat.id);
        hits.push(sat);
      }
      if (hits.length >= limit * 6) break;
    }
  }

  // Prefix matches read as better answers than mid-string ones; an exact
  // NORAD hit stays pinned at the top.
  const exact = numeric !== null && hits[0]?.id === numeric ? hits.shift() : null;
  hits.sort((a, b) => {
    const ap = a.name.toUpperCase().startsWith(needle) ? 0 : 1;
    const bp = b.name.toUpperCase().startsWith(needle) ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });
  if (exact) hits.unshift(exact);

  return { query: q, scope, count: Math.min(hits.length, limit), sats: hits.slice(0, limit) };
}

/** Group metadata for the UI, without touching the network. */
export function groupCatalog() {
  return Object.entries(GROUPS).map(([id, def]) => ({
    id,
    label: def.label,
    color: def.color,
    blurb: def.blurb,
    cap: def.cap,
    cached: [...def.sources, ...(def.mined || [])].every((s) => memory.has(s)),
  }));
}

/**
 * Pull groups in the background so the first click is instant. `military`
 * is in the list because it drags in the `active` catalogue, which is also
 * what search needs — better to pay for it at boot than on a keystroke.
 */
export async function warmTle(groups = ['stations', 'visual', 'military']) {
  for (const id of groups) {
    try {
      await getGroup(id);
    } catch (err) {
      console.warn(`[tle] warm ${id} failed: ${err.message}`);
    }
  }
}
