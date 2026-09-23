/**
 * Per-station dose-rate history for the European background networks.
 *
 * A fixed threshold (0.5 µSv/h) misses a local release in a low-background
 * area: a probe that normally reads 0.07 and jumps to 0.30 is far more
 * interesting than one on granite that always reads 0.25. So every probe is
 * also judged against its own recent median.
 *
 * Storage is `node:sqlite` (built into Node >= 22.5, same as the AirWatch
 * baseline): one row per station per UTC hour, inserted with OR IGNORE, so a
 * sweep only writes the hours it has not seen. ~1,800 rows an hour, pruned to
 * the window. When node:sqlite is unavailable the feature switches off rather
 * than failing the source.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR_MS = 3600_000;

// Rain washes radon progeny out of the air and routinely lifts a probe by
// 30–50% for an hour or two, occasionally more. Requiring BOTH a doubling and
// an absolute rise keeps weather fronts from lighting up the map.
export const BASELINE_WINDOW_HOURS = 72;
export const BASELINE_MIN_SAMPLES = 12;
export const RISE_RATIO = 2;
export const RISE_MIN_DELTA_USVH = 0.1;

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'radiation-history.sqlite');

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length ? (v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2) : null;
}

export const hourOf = (iso) => Math.floor(Date.parse(iso) / HOUR_MS);

/**
 * Open a history store. `path` may be ':memory:' (tests).
 * Resolves to null when node:sqlite is missing.
 */
export async function openStationHistory(path = DEFAULT_PATH) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (err) {
    if (err?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return null;
    throw err;
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS station_hours (
      station TEXT NOT NULL,
      hour    INTEGER NOT NULL,
      usvh    REAL NOT NULL,
      PRIMARY KEY (station, hour)
    ) WITHOUT ROWID
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO station_hours (station, hour, usvh) VALUES (?, ?, ?)');
  const windowRows = db.prepare('SELECT station, hour, usvh FROM station_hours WHERE hour >= ? AND hour < ?');
  const prune = db.prepare('DELETE FROM station_hours WHERE hour < ?');
  let lastPruneHour = null;

  return {
    /**
     * Baselines for `stations` from history strictly before each station's
     * current observation hour. Returns Map(id -> { medianUSvH, samples }).
     */
    baselines(stations, now = Date.now()) {
      const nowHour = Math.floor(now / HOUR_MS);
      const byStation = new Map();
      for (const row of windowRows.all(nowHour - BASELINE_WINDOW_HOURS, nowHour + 1)) {
        let list = byStation.get(row.station);
        if (!list) byStation.set(row.station, (list = []));
        list.push(row);
      }
      const out = new Map();
      for (const s of stations) {
        if (!s.id) continue;
        const current = hourOf(s.observedAt);
        const prior = (byStation.get(s.id) || []).filter(r => r.hour < current).map(r => r.usvh);
        if (prior.length >= BASELINE_MIN_SAMPLES) out.set(s.id, { medianUSvH: median(prior), samples: prior.length });
      }
      return out;
    },

    /** Store each station's current reading under its observation hour. */
    record(stations, now = Date.now()) {
      db.exec('BEGIN');
      try {
        for (const s of stations) {
          if (s.id && Number.isFinite(s.uSvH)) insert.run(s.id, hourOf(s.observedAt), s.uSvH);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const nowHour = Math.floor(now / HOUR_MS);
      if (lastPruneHour !== nowHour) {
        lastPruneHour = nowHour;
        prune.run(nowHour - BASELINE_WINDOW_HOURS - 1);
      }
    },

    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Stations reading well above their own recent median.
 * @returns {Array<{ station, baselineUSvH, ratio }>} sorted by ratio, highest first
 */
export function findRisingStations(stations, baselines) {
  const rising = [];
  for (const s of stations) {
    const base = baselines.get(s.id);
    if (!base || !(base.medianUSvH > 0)) continue;
    const ratio = s.uSvH / base.medianUSvH;
    if (ratio >= RISE_RATIO && s.uSvH - base.medianUSvH >= RISE_MIN_DELTA_USVH) {
      rising.push({ station: s, baselineUSvH: base.medianUSvH, ratio });
    }
  }
  return rising.sort((a, b) => b.ratio - a.ratio);
}
