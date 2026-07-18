/**
 * AirWatch rolling 24h activity baseline (Module: airwatch, Component 2).
 *
 * Stores per-category aircraft counts bucketed by UTC hour so the dashboard
 * can compare "right now" against a rolling 24h average and surface surges
 * (tanker/ISR pushes ahead of strikes are the signal we care about).
 *
 * Storage is `node:sqlite` (built into Node >= 22.5 — no native deps, which
 * matters on the Raspberry Pi). On older 22.x where the module is missing,
 * we fall back to an in-memory map persisted as JSON so the feature degrades
 * instead of crashing. Either way the file lives in data/ (gitignored).
 *
 * Write volume is one tiny upsert per poll (~80/hour) — negligible SD wear.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

const RETENTION_HOURS = 7 * 24;      // keep a week of hourly rows
const JSON_FLUSH_MS = 5 * 60 * 1000; // throttle JSON-fallback writes (SD wear)

let db = null;              // node:sqlite DatabaseSync, when available
let jsonStore = null;       // { [hourKey]: { [category]: { sum, n } } } fallback
let jsonPath = null;
let jsonDirty = false;
let jsonFlushTimer = null;
let lastPruneHour = null;

/** UTC hour bucket key, e.g. "2026-07-18T14". */
export function hourKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function hoursAgoKey(hours) {
  return hourKey(new Date(Date.now() - hours * 3600_000));
}

/**
 * Open the store. Tries node:sqlite first; falls back to JSON persistence.
 * Returns the backend name actually in use ('sqlite' | 'json').
 */
export async function initBaseline(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS hourly_counts (
        hour     TEXT NOT NULL,
        category TEXT NOT NULL,
        sum      REAL NOT NULL DEFAULT 0,
        samples  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, category)
      )
    `);
    return 'sqlite';
  } catch {
    // node:sqlite unavailable (Node 22.0–22.4) — JSON fallback
    jsonPath = dbPath.replace(/\.sqlite$/, '') + '-baseline.json';
    try {
      jsonStore = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : {};
    } catch {
      jsonStore = {};
    }
    return 'json';
  }
}

function flushJson() {
  if (!jsonStore || !jsonDirty) return;
  try {
    writeFileSync(jsonPath, JSON.stringify(jsonStore));
    jsonDirty = false;
  } catch { /* non-fatal — baseline is best-effort */ }
}

function pruneOld() {
  const cutoff = hoursAgoKey(RETENTION_HOURS);
  if (db) {
    db.prepare('DELETE FROM hourly_counts WHERE hour < ?').run(cutoff);
  } else if (jsonStore) {
    for (const h of Object.keys(jsonStore)) if (h < cutoff) delete jsonStore[h];
    jsonDirty = true;
  }
}

/**
 * Record one poll's category counts into the current UTC hour bucket.
 * @param {Record<string, number>} counts e.g. { TANKER: 4, ISR: 2, ... }
 */
export function recordSample(counts) {
  if (!db && !jsonStore) return;
  const hour = hourKey();

  if (db) {
    const stmt = db.prepare(`
      INSERT INTO hourly_counts (hour, category, sum, samples) VALUES (?, ?, ?, 1)
      ON CONFLICT(hour, category) DO UPDATE SET
        sum = sum + excluded.sum, samples = samples + 1
    `);
    for (const [category, count] of Object.entries(counts)) {
      stmt.run(hour, category, count);
    }
  } else {
    const bucket = (jsonStore[hour] ||= {});
    for (const [category, count] of Object.entries(counts)) {
      const cell = (bucket[category] ||= { sum: 0, n: 0 });
      cell.sum += count;
      cell.n += 1;
    }
    jsonDirty = true;
    if (!jsonFlushTimer) {
      jsonFlushTimer = setInterval(flushJson, JSON_FLUSH_MS);
      jsonFlushTimer.unref?.();
    }
  }

  // Prune at most once per hour
  if (lastPruneHour !== hour) {
    lastPruneHour = hour;
    pruneOld();
  }
}

/**
 * Rolling 24h baseline: for each category, the mean count across all samples
 * in the previous 24 full hours (the in-progress hour is excluded so a
 * half-full bucket can't skew the average).
 *
 * @returns {{ perCategory: Record<string, number>, hours: number }}
 *   hours = distinct hour buckets contributing — callers should treat the
 *   baseline as immature until this is reasonably large (e.g. >= 6).
 */
export function getBaseline() {
  const currentHour = hourKey();
  const cutoff = hoursAgoKey(24);
  const perCategory = {};
  let hours = 0;

  if (db) {
    const rows = db.prepare(`
      SELECT category, SUM(sum) AS s, SUM(samples) AS n
      FROM hourly_counts WHERE hour >= ? AND hour < ? GROUP BY category
    `).all(cutoff, currentHour);
    for (const row of rows) {
      perCategory[row.category] = row.n > 0 ? row.s / row.n : 0;
    }
    const hourRow = db.prepare(
      'SELECT COUNT(DISTINCT hour) AS h FROM hourly_counts WHERE hour >= ? AND hour < ?'
    ).get(cutoff, currentHour);
    hours = hourRow?.h || 0;
  } else if (jsonStore) {
    const agg = {};
    for (const [h, bucket] of Object.entries(jsonStore)) {
      if (h < cutoff || h >= currentHour) continue;
      hours++;
      for (const [category, cell] of Object.entries(bucket)) {
        const a = (agg[category] ||= { sum: 0, n: 0 });
        a.sum += cell.sum;
        a.n += cell.n;
      }
    }
    for (const [category, a] of Object.entries(agg)) {
      perCategory[category] = a.n > 0 ? a.sum / a.n : 0;
    }
  }

  return { perCategory, hours };
}

/** Flush and close (called from server shutdown; safe to call twice). */
export function closeBaseline() {
  if (jsonFlushTimer) { clearInterval(jsonFlushTimer); jsonFlushTimer = null; }
  flushJson();
  try { db?.close(); } catch { /* already closed */ }
  db = null;
  jsonStore = null;
}
