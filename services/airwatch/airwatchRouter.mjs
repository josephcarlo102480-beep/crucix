/**
 * Express router for AirWatch military aircraft tracking (Module: airwatch).
 *
 * Mounted at `/api/airwatch` by server.mjs. Serves ONLY from the poller's
 * in-memory cache — an incoming request never triggers an upstream fetch.
 * Returns 503 { status: "loading" } until the first successful poll,
 * mirroring the telegram/sanctions module pattern.
 *
 *   GET /api/airwatch/aircraft?scope=region|global → current filtered list
 *   GET /api/airwatch/stats                        → counts vs 24h baseline
 */

import { Router } from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  startPoller, stopPoller, getSnapshot, getSourceStatus,
  countByCategory, CATEGORIES, REGION,
} from './airwatchPoller.mjs';
import {
  initBaseline, recordSample, getBaseline, closeBaseline,
} from './airwatchBaseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'airwatch.sqlite');

// Baseline needs ~this many hour-buckets before surge deltas mean anything.
const BASELINE_MIN_HOURS = 6;
const STALE_AFTER_SECONDS = 180;

// Military aircraft routinely disable ADS-B over contested airspace, so an
// empty list is expected behavior, not an error.
const COVERAGE_NOTE = 'No broadcasting military aircraft in view. Mil aircraft '
  + 'often fly dark (ADS-B off) over contested airspace, and receiver coverage '
  + 'over Iran, Iraq and Syria is sparse — an empty picture is a coverage gap, '
  + 'not necessarily an empty sky.';

const router = Router();

function snapshotMeta(snapshot) {
  const ageSeconds = Math.round((Date.now() - new Date(snapshot.fetchedAt).getTime()) / 1000);
  return {
    ready: true,
    source: snapshot.source,
    sourceStatus: getSourceStatus(),
    fetchedAt: snapshot.fetchedAt,
    ageSeconds,
    stale: ageSeconds > STALE_AFTER_SECONDS,
  };
}

// GET /api/airwatch/aircraft?scope=region|global
router.get('/aircraft', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = getSnapshot();
  if (!snapshot) {
    return res.status(503).json({ status: 'loading', sourceStatus: getSourceStatus() });
  }
  const scope = req.query.scope === 'global' ? 'global' : 'region';
  const aircraft = scope === 'global' ? snapshot.aircraft : snapshot.regionAircraft;
  res.json({
    ...snapshotMeta(snapshot),
    scope,
    region: REGION,
    count: aircraft.length,
    globalCount: snapshot.aircraft.length,
    withoutPosition: snapshot.withoutPosition,
    note: aircraft.length === 0 ? COVERAGE_NOTE : null,
    aircraft,
  });
});

// GET /api/airwatch/stats — region-scoped counts vs rolling 24h baseline
router.get('/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = getSnapshot();
  if (!snapshot) {
    return res.status(503).json({ status: 'loading', sourceStatus: getSourceStatus() });
  }
  const current = countByCategory(snapshot.regionAircraft);
  const { perCategory: baseline, hours } = getBaseline();
  const mature = hours >= BASELINE_MIN_HOURS;

  const categories = {};
  for (const cat of CATEGORIES) {
    const now = current[cat] || 0;
    const base = baseline[cat] ?? null;
    // Activity score: current vs rolling 24h mean. ±15% dead band so tiny
    // fluctuations around small counts don't flap the trend arrows.
    let trend = 'flat';
    let deltaPct = null;
    if (mature && base != null) {
      deltaPct = base > 0 ? Math.round(((now - base) / base) * 100) : (now > 0 ? 100 : 0);
      if (now > base * 1.15) trend = 'up';
      else if (now < base * 0.85) trend = 'down';
    }
    categories[cat] = { current: now, baseline24h: base != null ? Number(base.toFixed(1)) : null, deltaPct, trend };
  }

  res.json({
    ...snapshotMeta(snapshot),
    scope: 'region',
    region: REGION,
    totalCurrent: snapshot.regionAircraft.length,
    globalCount: snapshot.aircraft.length,
    categories,
    baseline: { hours, mature, minHours: BASELINE_MIN_HOURS },
  });
});

/**
 * Fire-and-forget boot warm: open the baseline store, then start the 45s
 * poller. Exposed so server.mjs can call it once on listen (same pattern as
 * warmTelegram / warmSanctionsCache).
 */
export async function warmAirwatch() {
  let backend = 'disabled';
  try {
    backend = await initBaseline(DB_PATH);
  } catch (err) {
    console.warn('[AirWatch] Baseline store unavailable (non-fatal):', err?.message || err);
  }
  const ok = await startPoller({ onSample: recordSample });
  console.log(`[AirWatch] Poller started (baseline: ${backend})`);
  return ok;
}

/** Stop the poller and flush/close the baseline store (server shutdown). */
export function stopAirwatch() {
  stopPoller();
  closeBaseline();
}

export default router;
