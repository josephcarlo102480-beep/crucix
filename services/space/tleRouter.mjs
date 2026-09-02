/**
 * Express router for orbital elements (Module: space).
 *
 * Mounted at `/api/tle` by server.mjs. Fronts CelesTrak so the browser never
 * talks to it directly — that keeps the tracker off a third party's rate
 * limiter, avoids a CORS dependency, and lets one cached fetch serve every
 * open tab.
 *
 *   GET /api/tle/groups             → catalog metadata for the UI
 *   GET /api/tle/search?q=…&limit=… → name / NORAD lookup over ~16k objects
 *   GET /api/tle/:group?limit=…     → elements for one display group
 */

import { Router } from 'express';
import { clampInt } from '../../lib/util/net.mjs';
import { getGroup, search, groupCatalog } from './tleCatalog.mjs';

const router = Router();

// Elements change on the order of hours; letting the browser hold them for a
// few minutes stops a page reload from re-transferring 400 satellites.
const BROWSER_CACHE = 'public, max-age=300';

function clampLimit(raw, max) {
  const n = clampInt(raw, { min: 0, max, fallback: 0 });
  return n < 1 ? undefined : n;
}

router.get('/groups', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ groups: groupCatalog() });
});

router.get('/search', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await search(req.query.q, clampLimit(req.query.limit, 100) || 40));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

router.get('/:group', async (req, res) => {
  try {
    const payload = await getGroup(req.params.group, clampLimit(req.query.limit, 4000));
    res.set('Cache-Control', payload.stale ? 'no-store' : BROWSER_CACHE);
    res.json(payload);
  } catch (err) {
    res.set('Cache-Control', 'no-store');
    res.status(err.status || 502).json({ error: err.message, group: req.params.group });
  }
});

export default router;
