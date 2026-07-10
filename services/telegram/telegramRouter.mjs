/**
 * Express router for the Telegram geoparse layer (Module A, Component 3).
 *
 * Mounted at `/api/telegram` by server.mjs. Combines the channel scraper
 * (telegramFeed) with the GeoNames geoparser (geoparse). Returns 503
 * { status: "loading" } until the gazetteer is built — mirroring the
 * sanctions module's isReady()/warmCache() pattern.
 *
 *   GET /api/telegram/posts   → { ready, updated, count, geolocated, posts }
 *   GET /api/telegram/status  → channels, last refresh, gazetteer size, ready
 */

import { Router } from 'express';
import {
  setChannels, getChannels, getPosts, lastUpdated, warmFeed,
} from './telegramFeed.mjs';
import {
  warmGazetteer, isReady as gazetteerReady, geoparsePosts, gazetteerSize, cityTotal,
} from './geoparse.mjs';

const router = Router();

// ── Channel configuration ───────────────────────────────────────────────
// CRUCIX_TELEGRAM_CHANNELS = comma-separated handles. There is NO OSIRIS
// default to inherit. The fallback below is a small set of public conflict-
// monitoring channels that currently expose web previews (verified to render
// posts via https://t.me/s/<channel>).
// TODO(G): replace with your own curated channel list via the env var.
const DEFAULT_CHANNELS = [
  'war_monitor',
  'WarMonitors',
  'rybar',
  'DeepStateUA',
  'Pravda_Gerashchenko',
];

function resolveChannels() {
  const env = process.env.CRUCIX_TELEGRAM_CHANNELS || process.env.TELEGRAM_CHANNELS;
  if (!env?.trim()) return DEFAULT_CHANNELS;
  const extras = env.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_CHANNELS, ...extras])];
}

// Apply channel config once at module load (env is read at boot).
setChannels(resolveChannels());

// Memoize geoparsing per feed snapshot so we don't re-scan every request.
let memo = { fetchedAt: 0, payload: null };

function buildPayload(snapshot) {
  if (memo.payload && memo.fetchedAt === snapshot.fetchedAt) return memo.payload;
  const posts = geoparsePosts(snapshot.posts.map((p) => ({ ...p }))); // copy + attach geo
  const geolocated = posts.filter((p) => p.geo && p.geo.length > 0).length;
  const payload = {
    ready: true,
    updated: lastUpdated(),
    count: posts.length,
    geolocated,
    posts,
  };
  memo = { fetchedAt: snapshot.fetchedAt, payload };
  return payload;
}

// GET /api/telegram/posts
router.get('/posts', async (req, res) => {
  if (!gazetteerReady()) {
    warmGazetteer().catch(() => {}); // nudge in case boot warm was skipped
    return res.status(503).json({ status: 'loading' });
  }
  try {
    const snapshot = await getPosts();
    res.set('Cache-Control', 'no-store');
    return res.json(buildPayload(snapshot));
  } catch (e) {
    return res.status(502).json({ error: 'Telegram feed failed', detail: e?.message || String(e) });
  }
});

// GET /api/telegram/status
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ready: gazetteerReady(),
    channels: getChannels(),
    lastRefresh: lastUpdated(),
    gazetteerEntries: gazetteerSize(),
    gazetteerCities: cityTotal(),
  });
});

/**
 * Fire-and-forget boot warm: build the gazetteer, then kick the first scrape.
 * Exposed so server.mjs can call it once on listen.
 */
export async function warmTelegram() {
  const okGaz = await warmGazetteer();
  // Start the first scrape regardless; posts are useful even pre-gazetteer,
  // and the gazetteer warm may still be retrying.
  warmFeed().catch(() => {});
  return okGaz;
}

export default router;
