/**
 * Express router for the OFAC SDN sanctions search (Module C).
 *
 * Isolated, request-driven lookup over the in-memory OpenSanctions index.
 * Mounted at `/api/sanctions` by server.mjs. Until the cache is warm the
 * endpoint returns 503 { status: "loading" }.
 */

import { Router } from 'express';
import { searchSanctions, isReady, warmCache, indexSize } from './ofacSanctions.mjs';

const router = Router();

// Allowed entity-type filters (mirrors OSIRIS's ALLOWED_SCHEMAS).
const ALLOWED_SCHEMAS = [
  'Person',
  'Organization',
  'Company',
  'Vessel',
  'Airplane',
  'LegalEntity',
];

// GET /api/sanctions/search?q=<term>[&schema=Person][&limit=25]
router.get('/search', async (req, res) => {
  if (!isReady()) {
    // Kick off a warm in the background in case boot warm-up was skipped.
    warmCache().catch(() => {});
    return res.status(503).json({ status: 'loading' });
  }

  const query = String(req.query.q ?? req.query.query ?? '').trim();
  const schemaParam = req.query.schema ? String(req.query.schema) : null;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }
  if (query.length < 4) {
    return res.status(400).json({ error: 'Query must be at least 4 characters' });
  }

  let schema;
  if (schemaParam) {
    if (!ALLOWED_SCHEMAS.includes(schemaParam)) {
      return res.status(400).json({
        error: `Invalid schema. Allowed: ${ALLOWED_SCHEMAS.join(', ')}`,
      });
    }
    schema = schemaParam;
  }

  try {
    const results = await searchSanctions(query, { schema, limit });
    res.set('Cache-Control', 'no-store');
    return res.json({
      ready: true,
      query,
      schema: schema ?? null,
      total: results.length,
      results,
      source: 'OpenSanctions / US OFAC SDN',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({
      error: 'Sanctions lookup failed',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});

// GET /api/sanctions/status — lightweight readiness probe for the panel.
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ready: isReady(), count: indexSize() });
});

export default router;
