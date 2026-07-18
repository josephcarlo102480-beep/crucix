/**
 * AirWatch military aircraft poller (Module: airwatch, Component 1).
 *
 * Polls the free military-aircraft feeds and keeps the latest result in
 * memory — the poller is the ONLY thing that talks upstream; page loads and
 * API requests always read the cache.
 *
 *   Primary : https://api.airplanes.live/v2/mil   (free, no key)
 *   Fallback: https://api.adsb.lol/v2/mil         (same response shape)
 *
 * Failover is automatic and sticky: if the active source errors or
 * rate-limits (429 puts it in a 5-minute cooldown), the other one is tried
 * in the same cycle and becomes active on success. When BOTH fail, the poll
 * interval backs off exponentially (45s → 90s → ... → 5 min cap) per both
 * projects' usage guidance; a descriptive User-Agent identifies us.
 *
 * No API keys exist for these feeds and none are needed.
 */

const POLL_MS = clampInt(process.env.CRUCIX_AIRWATCH_POLL_SECONDS, 45, 30, 600) * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Crucix-AirWatch/2.0 (+https://github.com/josephcarlo102480-beep/crucix; self-hosted OSINT dashboard; 1 req/45s)';

const SOURCES = [
  { id: 'airplanes.live', url: 'https://api.airplanes.live/v2/mil' },
  { id: 'adsb.lol', url: 'https://api.adsb.lol/v2/mil' },
];

// Middle East / Gulf / eastern Med bounding box
export const REGION = { latMin: 12, latMax: 42, lonMin: 25, lonMax: 65 };

export const CATEGORIES = ['TANKER', 'ISR', 'HEAVY', 'FIGHTER', 'HELO', 'OTHER'];

// ── Classification by ICAO type designator ──────────────────────────────
// Exact designators as they appear in the feeds' `t` field. DC10 in a
// military-only feed is a KC-10; A330s in a military-only feed are MRTT /
// Voyager tankers.
const TYPE_EXACT = {
  // Tankers
  K35R: 'TANKER', K35E: 'TANKER', K35A: 'TANKER', KC35: 'TANKER',
  K46: 'TANKER', KC46: 'TANKER', DC10: 'TANKER', KC10: 'TANKER',
  A332: 'TANKER', A333: 'TANKER', MRTT: 'TANKER',
  // ISR / AEW / maritime patrol / high-altitude recon
  R135: 'ISR', RC135: 'ISR', E3CF: 'ISR', E3TF: 'ISR', E3: 'ISR',
  E6: 'ISR', E8: 'ISR', E737: 'ISR', E2: 'ISR', E2C: 'ISR', E2D: 'ISR',
  P8: 'ISR', P3: 'ISR', U2: 'ISR', RQ4: 'ISR', RQ4B: 'ISR',
  MQ9: 'ISR', MQ4: 'ISR', Q4: 'ISR',
  // Heavy lift
  C17: 'HEAVY', C5: 'HEAVY', C5M: 'HEAVY', A400: 'HEAVY',
  C130: 'HEAVY', C30J: 'HEAVY', K30J: 'HEAVY',
  // Helicopters (category A7 below is the catch-all)
  H47: 'HELO', H53: 'HELO', H53S: 'HELO', H60: 'HELO', H64: 'HELO',
  UH1: 'HELO', UH1Y: 'HELO', AH1: 'HELO', NH90: 'HELO', EH10: 'HELO',
  TIGR: 'HELO', LYNX: 'HELO',
};

// Prefix rules for families with many sub-designators (F16 → F16, F16C...)
const TYPE_PREFIX = [
  ['K35', 'TANKER'],
  ['R135', 'ISR'], ['RQ4', 'ISR'], ['MQ9', 'ISR'],
  ['C130', 'HEAVY'], ['C30', 'HEAVY'],
  ['F16', 'FIGHTER'], ['F15', 'FIGHTER'], ['F18', 'FIGHTER'], ['F14', 'FIGHTER'],
  ['F22', 'FIGHTER'], ['F35', 'FIGHTER'], ['F4', 'FIGHTER'], ['A10', 'FIGHTER'],
  ['EUFI', 'FIGHTER'], ['TYPH', 'FIGHTER'], ['RFAL', 'FIGHTER'], ['MIR2', 'FIGHTER'],
  ['M2000', 'FIGHTER'], ['TOR', 'FIGHTER'], ['MG29', 'FIGHTER'], ['MG31', 'FIGHTER'],
  ['SU27', 'FIGHTER'], ['SU30', 'FIGHTER'], ['SU35', 'FIGHTER'], ['SU57', 'FIGHTER'],
  ['H47', 'HELO'], ['H53', 'HELO'], ['H60', 'HELO'], ['H64', 'HELO'],
];

// Description-keyword fallback for aircraft the feeds report under their
// civilian airframe code (e.g. KC-46A as B762, E-7 as B738/E737) — checked
// only when the type-designator tables miss, so an explicit code always wins.
const DESC_KEYWORDS = [
  [/KC-?46|PEGASUS|KC-?135|STRATOTANKER|KC-?10|EXTENDER|KC-?767|MRTT|VOYAGER/, 'TANKER'],
  [/RIVET ?JOINT|AWACS|SENTRY|WEDGETAIL|JSTARS|POSEIDON|GLOBAL ?HAWK|REAPER|HAWKEYE|DRAGON ?LADY|COMPASS ?CALL|GUARDRAIL/, 'ISR'],
  [/GLOBEMASTER|GALAXY|HERCULES|A400M/, 'HEAVY'],
  [/FIGHTING ?FALCON|STRIKE ?EAGLE|SUPER ?HORNET|HORNET|LIGHTNING ?II|RAPTOR|TYPHOON|RAFALE|GRIPEN|THUNDERBOLT/, 'FIGHTER'],
  [/BLACK ?HAWK|PAVE ?HAWK|SEAHAWK|CHINOOK|APACHE|STALLION|OSPREY|MERLIN|COBRA|VENOM/, 'HELO'],
];

/**
 * Classify an aircraft into one of CATEGORIES.
 * @param {string} type ICAO type designator (feed `t` field)
 * @param {string} emitterCategory ADS-B emitter category (feed `category`,
 *   e.g. 'A7' = rotorcraft) — used as a helicopter catch-all.
 * @param {string} desc feed `desc` field (e.g. "BOEING KC-46A Pegasus") —
 *   fallback for tankers/ISR flying under civilian airframe codes.
 */
export function classify(type, emitterCategory, desc) {
  const t = String(type || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t && TYPE_EXACT[t]) return TYPE_EXACT[t];
  if (t) {
    for (const [prefix, cat] of TYPE_PREFIX) {
      if (t.startsWith(prefix)) return cat;
    }
  }
  const d = String(desc || '').toUpperCase();
  if (d) {
    for (const [pattern, cat] of DESC_KEYWORDS) {
      if (pattern.test(d)) return cat;
    }
  }
  if (String(emitterCategory || '').toUpperCase() === 'A7') return 'HELO';
  return 'OTHER';
}

// ── Origin country from ICAO 24-bit hex allocation ──────────────────────
// Compact table of the allocations most relevant to this theatre (plus the
// big operators). Best-effort annotation — unknown ranges return null.
const HEX_COUNTRY = [
  [0x010000, 0x017FFF, 'Egypt'],
  [0x06A000, 0x06AFFF, 'Qatar'],
  [0x100000, 0x1FFFFF, 'Russia'],
  [0x300000, 0x33FFFF, 'Italy'],
  [0x340000, 0x37FFFF, 'Spain'],
  [0x380000, 0x3BFFFF, 'France'],
  [0x3C0000, 0x3FFFFF, 'Germany'],
  [0x400000, 0x43FFFF, 'United Kingdom'],
  [0x440000, 0x447FFF, 'Austria'],
  [0x448000, 0x44FFFF, 'Belgium'],
  [0x458000, 0x45FFFF, 'Denmark'],
  [0x460000, 0x467FFF, 'Finland'],
  [0x468000, 0x46FFFF, 'Greece'],
  [0x478000, 0x47FFFF, 'Norway'],
  [0x480000, 0x487FFF, 'Netherlands'],
  [0x488000, 0x48FFFF, 'Poland'],
  [0x490000, 0x497FFF, 'Portugal'],
  [0x498000, 0x49FFFF, 'Czechia'],
  [0x4A8000, 0x4AFFFF, 'Sweden'],
  [0x4B0000, 0x4B7FFF, 'Switzerland'],
  [0x4B8000, 0x4BFFFF, 'Turkey'],
  [0x508000, 0x50FFFF, 'Ukraine'],
  [0x600000, 0x6003FF, 'Azerbaijan'],
  [0x706000, 0x706FFF, 'Kuwait'],
  [0x70C000, 0x70C3FF, 'Oman'],
  [0x710000, 0x717FFF, 'Saudi Arabia'],
  [0x728000, 0x72FFFF, 'Iraq'],
  [0x730000, 0x737FFF, 'Iran'],
  [0x738000, 0x73FFFF, 'Israel'],
  [0x740000, 0x747FFF, 'Jordan'],
  [0x748000, 0x74FFFF, 'Lebanon'],
  [0x760000, 0x767FFF, 'Pakistan'],
  [0x778000, 0x77FFFF, 'Syria'],
  [0x7C0000, 0x7FFFFF, 'Australia'],
  [0x800000, 0x83FFFF, 'India'],
  [0x894000, 0x894FFF, 'Bahrain'],
  [0x896000, 0x896FFF, 'UAE'],
  [0xA00000, 0xAFFFFF, 'United States'],
  [0xC00000, 0xC3FFFF, 'Canada'],
];

export function hexCountry(hex) {
  const n = parseInt(String(hex || ''), 16);
  if (!Number.isFinite(n)) return null;
  for (const [start, end, country] of HEX_COUNTRY) {
    if (n >= start && n <= end) return country;
  }
  return null;
}

export function inRegion(lat, lon) {
  return lat >= REGION.latMin && lat <= REGION.latMax
    && lon >= REGION.lonMin && lon <= REGION.lonMax;
}

/** Normalize one raw feed aircraft record into our wire format (or null). */
export function normalizeAircraft(ac) {
  const lat = Number(ac?.lat);
  const lon = Number(ac?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null; // Mode-S only, no position
  const type = ac.t || null;
  const alt = ac.alt_baro === 'ground' ? 0
    : Number.isFinite(Number(ac.alt_baro)) ? Number(ac.alt_baro)
    : Number.isFinite(Number(ac.alt_geom)) ? Number(ac.alt_geom) : null;
  const track = Number.isFinite(Number(ac.track)) ? Number(ac.track)
    : Number.isFinite(Number(ac.true_heading)) ? Number(ac.true_heading) : null;
  return {
    hex: String(ac.hex || '').trim(),
    callsign: String(ac.flight || '').trim() || null,
    reg: ac.r || null,
    type,
    desc: ac.desc || null,
    operator: ac.ownOp || null,
    cat: classify(type, ac.category, ac.desc),
    lat, lon, alt,
    gs: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : null,
    track,
    squawk: ac.squawk || null,
    country: hexCountry(ac.hex),
    seenPos: Number.isFinite(Number(ac.seen_pos)) ? Number(ac.seen_pos) : null,
  };
}

export function countByCategory(aircraft) {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  for (const ac of aircraft) counts[ac.cat] = (counts[ac.cat] || 0) + 1;
  return counts;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Exponential backoff delay after `failStreak` consecutive all-source failures. */
export function backoffDelay(failStreak, baseMs = POLL_MS, maxMs = BACKOFF_MAX_MS) {
  if (failStreak <= 0) return baseMs;
  return Math.min(baseMs * 2 ** failStreak, maxMs);
}

// ── Poller state ────────────────────────────────────────────────────────
const state = {
  cache: null,          // { fetchedAt, source, aircraft, regionAircraft, withoutPosition, feedTotal }
  activeIdx: 0,         // sticky preferred source index
  failStreak: 0,        // consecutive cycles where ALL sources failed
  rateLimitedUntil: SOURCES.map(() => 0),
  lastError: SOURCES.map(() => null),
  timer: null,
  running: false,
  onSample: null,       // hook: (countsByCategory) => void, set by the router
};

async function fetchSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    if (res.status === 429) {
      const err = new Error('HTTP 429 (rate limited)');
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.ac)) throw new Error('Malformed response (no ac array)');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function pollOnce() {
  const now = Date.now();
  // Active source first, then the other(s); skip sources in 429 cooldown
  // unless everything is cooling down (then try anyway rather than go blind).
  const order = [...SOURCES.keys()].sort((a, b) =>
    (a === state.activeIdx ? -1 : 0) - (b === state.activeIdx ? -1 : 0));
  const eligible = order.filter(i => state.rateLimitedUntil[i] <= now);
  const tryOrder = eligible.length ? eligible : order;

  for (const idx of tryOrder) {
    const source = SOURCES[idx];
    try {
      const data = await fetchSource(source);
      const aircraft = data.ac.map(normalizeAircraft).filter(Boolean);
      const regionAircraft = aircraft.filter(ac => inRegion(ac.lat, ac.lon));
      state.cache = {
        fetchedAt: new Date().toISOString(),
        source: source.id,
        aircraft,
        regionAircraft,
        withoutPosition: data.ac.length - aircraft.length,
        feedTotal: data.ac.length,
      };
      state.activeIdx = idx;
      state.failStreak = 0;
      state.lastError[idx] = null;
      try { state.onSample?.(countByCategory(regionAircraft)); } catch { /* baseline is best-effort */ }
      return true;
    } catch (err) {
      state.lastError[idx] = `${err?.message || err} @ ${new Date().toISOString()}`;
      if (err?.rateLimited) state.rateLimitedUntil[idx] = now + RATE_LIMIT_COOLDOWN_MS;
      console.warn(`[AirWatch] ${source.id} failed: ${err?.message || err}`);
    }
  }
  state.failStreak++;
  return false;
}

function scheduleNext() {
  if (!state.running) return;
  const delay = backoffDelay(state.failStreak);
  if (state.failStreak > 0) {
    console.warn(`[AirWatch] All sources failed (streak ${state.failStreak}) — next attempt in ${Math.round(delay / 1000)}s`);
  }
  state.timer = setTimeout(runCycle, delay);
  state.timer.unref?.();
}

async function runCycle() {
  await pollOnce();
  scheduleNext();
}

/** Start polling (idempotent). Resolves after the FIRST fetch attempt. */
export async function startPoller({ onSample } = {}) {
  if (onSample) state.onSample = onSample;
  if (state.running) return !!state.cache;
  state.running = true;
  const ok = await pollOnce();
  scheduleNext();
  return ok;
}

export function stopPoller() {
  state.running = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

/** Latest cached result (null until the first successful poll). */
export function getSnapshot() {
  return state.cache;
}

/** Source/health status for the API + UI. */
export function getSourceStatus() {
  const now = Date.now();
  return {
    active: SOURCES[state.activeIdx].id,
    pollSeconds: POLL_MS / 1000,
    failStreak: state.failStreak,
    sources: SOURCES.map((s, i) => ({
      id: s.id,
      role: i === 0 ? 'primary' : 'fallback',
      rateLimitedForSeconds: Math.max(0, Math.ceil((state.rateLimitedUntil[i] - now) / 1000)) || 0,
      lastError: state.lastError[i],
    })),
  };
}
