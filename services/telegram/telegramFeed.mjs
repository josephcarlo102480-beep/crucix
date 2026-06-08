/**
 * Telegram public-channel preview scraper (Module A, Component 1).
 *
 * Built from scratch (NOT ported — OSIRIS never had this). Fetches the
 * unauthenticated server-rendered preview at https://t.me/s/<channel> and
 * parses posts out of the DOM with cheerio. No Bot API, no MTProto, no auth.
 *
 * t.me/s is rate-limited by IP, so we fetch channels sequentially with a
 * small delay and a real browser User-Agent. A channel that 404s, times out
 * or has previews disabled is skipped — the rest still return.
 *
 * Caching mirrors services/cctv/cctvCameras.mjs: a single in-memory snapshot,
 * refreshed every 12 minutes with single-flight, serving the stale snapshot
 * if a refresh fails so the endpoint never goes blind.
 */

import * as cheerio from 'cheerio';

const REFRESH_MS = 12 * 60 * 1000;
const PER_CHANNEL_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 15000;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let cache = null;       // { fetchedAt, posts }
let inflight = null;    // Promise
let configuredChannels = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalize a channel handle: strip @, URL prefixes, whitespace. */
export function normalizeChannel(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/t\.me\/(s\/)?/i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .trim();
}

/** Set the channel list the scraper should pull (from env, via the router). */
export function setChannels(channels) {
  configuredChannels = (channels || []).map(normalizeChannel).filter(Boolean);
}

export function getChannels() {
  return [...configuredChannels];
}

/** Parse one channel's preview HTML into normalized post objects. */
function parseChannelHtml(channel, html) {
  const $ = cheerio.load(html);
  const posts = [];
  $('.tgme_widget_message').each((_, el) => {
    const $msg = $(el);
    const dateEl = $msg.find('.tgme_widget_message_date').first();
    const link = dateEl.attr('href') || null;
    const ts = dateEl.find('time').attr('datetime') || null;

    const $text = $msg.find('.tgme_widget_message_text').first().clone();
    // Preserve line breaks the way a reader would see them.
    $text.find('br').replaceWith('\n');
    const text = $text.text().replace(/ /g, ' ').trim();

    const views = $msg.find('.tgme_widget_message_views').first().text().trim() || null;

    // Skip service messages / pure-media posts with no text and no link.
    if (!text && !link) return;

    posts.push({
      channel,
      text,
      ts: ts ? new Date(ts).toISOString() : null,
      link,
      views,
    });
  });
  return posts;
}

/** Fetch + parse a single channel. Returns [] on any failure (never throws). */
async function scrapeChannel(channel) {
  const url = `https://t.me/s/${encodeURIComponent(channel)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en,ru,uk,ar' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[telegram] ${channel}: HTTP ${res.status} — skipped`);
      return [];
    }
    const html = await res.text();
    const posts = parseChannelHtml(channel, html);
    if (posts.length === 0) {
      console.warn(`[telegram] ${channel}: no posts (preview disabled or empty) — skipped`);
    }
    return posts;
  } catch (e) {
    console.warn(`[telegram] ${channel}: ${e?.message || e} — skipped`);
    return [];
  }
}

/** Scrape all configured channels sequentially (polite pacing). */
async function scrapeAll() {
  const all = [];
  for (let i = 0; i < configuredChannels.length; i++) {
    const channel = configuredChannels[i];
    const posts = await scrapeChannel(channel);
    all.push(...posts);
    if (i < configuredChannels.length - 1) await sleep(PER_CHANNEL_DELAY_MS);
  }
  // Newest first across all channels (posts with a ts sort ahead of those without).
  all.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return all;
}

/**
 * Return the current post snapshot. Refreshes every 12 min with single-flight;
 * serves the prior snapshot if a refresh yields nothing.
 */
export async function getPosts() {
  if (cache && Date.now() - cache.fetchedAt < REFRESH_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const posts = await scrapeAll();
      // If everything failed but we have a prior snapshot, keep it.
      if (posts.length === 0 && cache) return cache;
      const loaded = { fetchedAt: Date.now(), posts };
      cache = loaded;
      return loaded;
    } catch (e) {
      if (cache) return cache;
      throw e;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Last successful refresh time (ISO) or null. */
export function lastUpdated() {
  return cache ? new Date(cache.fetchedAt).toISOString() : null;
}

/** Fire-and-forget warm used on boot. */
export async function warmFeed() {
  try {
    await getPosts();
    return true;
  } catch {
    return false;
  }
}
