// Shared source-state contract for the sweep, cached snapshots and dashboard.
export function sourceState(source) {
  if (!source || typeof source !== 'object') return 'failed';
  const status = source.status;
  if (['unconfigured', 'no_key', 'no_credentials'].includes(status)) return 'unconfigured';
  if (source.stale || status === 'stale') return 'stale';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (source.error || ['degraded', 'limited', 'ready', 'no_data'].includes(status)) return 'degraded';
  return 'healthy';
}

const SETUP = {
  ACLED: 'Configure ACLED_EMAIL and ACLED_PASSWORD in .env, then restart Crucix.',
  Reddit: 'Configure REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env, then restart Crucix.',
  'Cloudflare-Radar': 'Configure CLOUDFLARE_API_TOKEN with Radar read access in .env, then restart Crucix.',
  FRED: 'Configure FRED_API_KEY in .env, then restart Crucix.',
  EIA: 'Configure EIA_API_KEY in .env, then restart Crucix.',
  FIRMS: 'Configure FIRMS_MAP_KEY in .env, then restart Crucix.',
  Maritime: 'The current maritime layer is static reference geometry. Live vessel coverage requires an AIS listener; adding a key alone does not collect positions.',
};

export function recoveryFor(name, status) {
  if (name === 'Maritime') return SETUP.Maritime;
  if (status === 'unconfigured') return SETUP[name] || 'Check this source’s credentials in .env and restart Crucix.';
  if (name === 'Safecast') return 'Wait for recent CPM observations near the affected sites. Missing or old readings cannot establish current conditions.';
  if (name === 'Patents') return 'Migrate this connector to the replacement USPTO service; retries against the retired API will not restore coverage.';
  if (name === 'EPA') return 'EPA may block automated clients even when its website works. For HTTP 403, request access guidance from dmap@epa.gov with the request URL, time and your public IP. Crucix retries next sweep.';
  if (name === 'OpenSky') return 'No observations means OpenSky returned no aircraft reports for that region; it does not establish an empty sky. Request failures are listed separately. Crucix retries next sweep.';
  if (name === 'Bluesky') return 'Check access to api.bsky.app; the cached public.api.bsky.app host can reject searches. Crucix retries next sweep.';
  if (name === 'Comtrade') return 'Reduce the requested trade pairs or increase the source budget. Partial results are retained; the next sweep retries.';
  if (status === 'stale') return 'Serving older observations. Check upstream availability; Crucix retries next sweep.';
  return 'Check upstream availability and any required credentials. Crucix retries next sweep.';
}

export function buildSourceHealth(sources = {}, errors = [], previous = [], checkedAt = null) {
  const prior = new Map(previous.map(h => [h.n || h.name, h]));
  const entries = new Map(Object.entries(sources));
  for (const e of errors) if (!entries.has(e.name)) entries.set(e.name, { status: 'failed', error: e.error });
  return [...entries].map(([name, src]) => {
    const status = sourceState(src);
    const old = prior.get(name);
    const observedAt = src.lastObservationAt || null;
    return {
      n: name, status, err: status !== 'healthy', stale: status === 'stale',
      checkedAt: src.timestamp || checkedAt,
      lastSuccessAt: status === 'healthy' ? (src.timestamp || checkedAt) : old?.lastSuccessAt || null,
      lastObservationAt: observedAt || old?.lastObservationAt || null,
      reason: status === 'healthy' ? null : String(src.error || src.message || `Source is ${status}`),
      recovery: status === 'healthy' ? null : recoveryFor(name, status),
    };
  });
}

export function sourceCounts(health) {
  const count = state => health.filter(h => h.status === state).length;
  return {
    sourcesQueried: health.length,
    sourcesOk: count('healthy'),
    sourcesDegraded: count('degraded'),
    sourcesStale: count('stale'),
    sourcesUnconfigured: count('unconfigured'),
    sourcesUnavailable: count('failed'),
    // Compatibility: older clients interpret this as all coverage gaps.
    sourcesFailed: health.filter(h => h.status !== 'healthy').length,
  };
}
