/**
 * Express router for the public CCTV camera layer (Module B).
 *
 * Mounted at `/api/cctv` by server.mjs. Camera locations are effectively
 * static, so the assembled list is served from a 12h in-memory cache.
 *
 *   GET /api/cctv/cameras            → { cameras, count, sources, updated }
 *   GET /api/cctv/snapshot?id=<id>   → streams a camera's current image
 *
 * The snapshot proxy is provided as a CORS/hotlink fallback — many feed URLs
 * are plain-HTTP or block cross-origin loads, which the browser cannot fetch
 * directly from the dashboard. The frontend prefers the direct URL and falls
 * back to this proxy.
 */

import { Router } from 'express';
import { getAllCameras, getCameraById, stealthFetch } from './cctvCameras.mjs';

const router = Router();

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

// GET /api/cctv/snapshot?id=<id> — fetch a camera's current image via the Pi
// (avoids browser CORS/hotlink/Referer/mixed-content issues entirely).
router.get('/snapshot', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });

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
    return res.status(415).json({ error: 'Camera has no proxyable image feed', external_url: cam.external_url || url || null });
  }

  // Some upstreams require a same-origin Referer to serve the frame.
  let referer;
  try { referer = new URL(cam.external_url || url).origin + '/'; } catch { /* ignore */ }

  try {
    const upstream = await stealthFetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
      headers: referer ? { Referer: referer } : undefined,
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
    }
    // Buffer (snapshots are small) so we can sniff and reject error bodies.
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ctHeader = (upstream.headers.get('content-type') || '').toLowerCase();
    const sniffed = sniffImageType(buf);
    const isImage = sniffed || /^image\//.test(ctHeader);
    if (!isImage || buf.length < 100) {
      return res.status(415).json({
        error: `Upstream is not an image (${ctHeader || 'no type'}, ${buf.length}b)`,
        external_url: cam.external_url || null,
      });
    }
    res.set('Content-Type', sniffed || ctHeader || 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'Snapshot fetch failed', detail: e?.message || String(e) });
    else res.end();
  }
});

export default router;
