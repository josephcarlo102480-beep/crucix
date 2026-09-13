// Freshness is a display/alert policy, not a radiation safety threshold.
export const RADIATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function radiationState(site, now = Date.now()) {
  const timestamp = Date.parse(site.lastReading);
  if (site.status === 'failed') return 'failed';
  // A site with no sensors in range is a known, permanent gap — not an outage.
  if (site.status === 'no_coverage') return 'no_coverage';
  if (!Number.isFinite(timestamp)) return 'unknown';
  if (now - timestamp > RADIATION_MAX_AGE_MS || timestamp > now + 5 * 60 * 1000) return 'stale';
  if (site.error || !(site.recentReadings > 0) || !Number.isFinite(site.avgCPM)) return 'unknown';
  return 'healthy';
}
