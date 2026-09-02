/**
 * Express router for the public CCTV camera layer (Module B).
 *
 * Mounted at `/api/cctv` by server.mjs. Camera locations are effectively
 * static, so the assembled list is served from a 12h in-memory cache.
 *
 *   GET /api/cctv/cameras            → { cameras, count, sources, updated }
 *   GET /api/cctv/snapshot?id=<id>   → streams a camera's current image
 *
 * The snapshot proxy exists because many feed URLs are plain-HTTP or block
 * cross-origin/hotlinked loads, which the browser cannot fetch directly from
 * the dashboard. The frontend is proxy-first for image feeds; a short
 * server-side cache (SNAP_TTL_MS) keeps the auto-refreshing popup from
 * hammering upstreams.
 */

import { Router } from 'express';
import { getAllCameras, getCameraById, stealthFetch } from './cctvCameras.mjs';
import { isPrivateHost } from '../../lib/util/net.mjs';

const router = Router();

/**
 * Warm the assembled-list cache at boot: assembly includes a YouTube liveness
 * sweep (~30 watch-page fetches), too slow to leave to the first visitor after
 * a restart.
 *
 * This is an explicit call rather than an import-time side effect on purpose.
 * It used to run at module scope, which meant merely importing this router —
 * from a test, a script, or diag.mjs — fired those fetches and left the
 * sockets open. server.mjs calls this once the HTTP server is listening, the
 * same way it warms AirWatch and the TLE catalogue.
 */
export async function warmCctv() {
  try {
    const { cameras } = await getAllCameras();
    return cameras.length;
  } catch {
    return 0; // best-effort; the first request will assemble on demand
  }
}

// GET /api/cctv/cameras — full assembled set (12h cache).
router.get('/cameras', async (req, res) => {
  try {
    const { cameras, sources, fetchedAt } = await getAllCameras();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      cameras,
      count: cameras.length,
      sources,
      updated: new Date(fetchedAt).toISOString(),
    });
  } catch (e) {
    res.status(500).json({ cameras: [], count: 0, error: 'Failed to assemble cameras', detail: e?.message || String(e) });
  }
});

// Detect an image from its leading magic bytes (JPEG/PNG/GIF/WebP/BMP). Some
// upstreams serve image bytes as application/octet-stream or with no type, so
// content-type alone isn't enough; sniffing also catches HTML/JSON error
// bodies returned with a 200 status.
function sniffImageType(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

// Per-camera snapshot micro-cache: the popup auto-refreshes every few seconds
// (and several clients may watch the same camera), but most traffic cams only
// update their frame every minute or more — no point re-fetching upstream.
const SNAP_TTL_MS = 5000;
const SNAP_MAX_BYTES = 5 * 1024 * 1024;
const SNAP_CACHE_MAX = 100;
const snapCache = new Map(); // id -> { at, buf, type }

function checkedSnapshotUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid snapshot URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported snapshot URL protocol');
  if (isPrivateHost(parsed.hostname)) throw new Error('Private snapshot hosts are not allowed');
  return parsed;
}

async function fetchSnapshot(url, headers) {
  let current = checkedSnapshotUrl(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    const upstream = await stealthFetch(current, {
      timeoutMs: 12_000,
      signal: controller.signal,
      redirect: 'manual',
      headers,
    });
    if (upstream.status < 300 || upstream.status >= 400) return { upstream, controller };
    const location = upstream.headers.get('location');
    if (!location) throw new Error(`Upstream redirect ${upstream.status} had no location`);
    if (redirects === 3) throw new Error('Too many snapshot redirects');
    await upstream.body?.cancel().catch(() => {});
    controller.abort();
    current = checkedSnapshotUrl(new URL(location, current).href);
  }
  throw new Error('Too many snapshot redirects');
}

async function readBodyCapped(response, controller) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > SNAP_MAX_BYTES) {
    controller.abort();
    throw new Error(`Snapshot exceeds ${SNAP_MAX_BYTES} byte limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SNAP_MAX_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new Error(`Snapshot exceeds ${SNAP_MAX_BYTES} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function cacheSnapshot(id, value) {
  const cutoff = Date.now() - SNAP_TTL_MS;
  for (const [key, cached] of snapCache) {
    if (cached.at < cutoff) snapCache.delete(key);
  }
  snapCache.delete(id);
  snapCache.set(id, value);
  while (snapCache.size > SNAP_CACHE_MAX) {
    snapCache.delete(snapCache.keys().next().value);
  }
}

// GET /api/cctv/snapshot?id=<id> — fetch a camera's current image via the Pi
// (avoids browser CORS/hotlink/Referer/mixed-content issues entirely).
router.get('/snapshot', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const cached = snapCache.get(id);
  if (cached && Date.now() - cached.at < SNAP_TTL_MS) {
    snapCache.delete(id);
    snapCache.set(id, cached);
    res.set('Content-Type', cached.type);
    res.set('Cache-Control', 'no-store');
    return res.send(cached.buf);
  }

  let cam;
  try {
    cam = await getCameraById(id);
  } catch {
    return res.status(503).json({ error: 'Camera list not ready' });
  }
  if (!cam) return res.status(404).json({ error: 'Unknown camera id' });

  const url = cam.feed_url || '';
  // Only proxy snapshot-style image feeds — not HLS/iframe streams.
  if (!/^https?:\/\//i.test(url) || cam.stream_type === 'hls' || cam.stream_type === 'iframe') {
    return res.status(422).json({ error: 'Camera has no proxyable image feed', external_url: cam.external_url || url || null });
  }

  try {
    checkedSnapshotUrl(url);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  // Some upstreams require a same-origin Referer to serve the frame.
  let referer;
  try { referer = new URL(cam.external_url || url).origin + '/'; } catch { /* ignore */ }

  try {
    const { upstream, controller } = await fetchSnapshot(
      url,
      referer ? { Referer: referer } : undefined,
    );
    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
    }
    const ctHeader = (upstream.headers.get('content-type') || '').toLowerCase();
    if (ctHeader.startsWith('multipart/') || ctHeader.startsWith('image/svg+xml')) {
      controller.abort();
      return res.status(502).json({ error: `Unsupported upstream image type (${ctHeader})` });
    }
    const buf = await readBodyCapped(upstream, controller);
    const sniffed = sniffImageType(buf);
    if (!sniffed) {
      return res.status(502).json({
        error: `Upstream is not an image (${ctHeader || 'no type'}, ${buf.length}b)`,
        external_url: cam.external_url || null,
      });
    }
    const type = sniffed;
    cacheSnapshot(id, { at: Date.now(), buf, type });
    res.set('Content-Type', type);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'Snapshot fetch failed', detail: e?.message || String(e) });
    else res.end();
  }
});

export default router;
