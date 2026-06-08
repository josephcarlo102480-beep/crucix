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

// GET /api/cctv/snapshot?id=<id> — stream a camera's current image via the Pi.
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

  try {
    const upstream = await stealthFetch(url, { signal: AbortSignal.timeout(12000) });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
    }
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) {
      return res.status(415).json({ error: `Upstream is not an image (${ct})` });
    }
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'no-store');
    // Stream the Web ReadableStream body through to the client.
    const reader = upstream.body.getReader();
    res.on('close', () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'Snapshot fetch failed', detail: e?.message || String(e) });
    else res.end();
  }
});

export default router;
