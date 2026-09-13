// Delta Engine v2 — compares two synthesized sweep results and produces structured changes
// Improvements: count metric thresholds, configurable thresholds, null-safety

// ─── Default Thresholds ──────────────────────────────────────────────────────
// Override via config.delta.thresholds in crucix.config.mjs

const DEFAULT_NUMERIC_THRESHOLDS = {
  vix: 5,            // % change to flag
  hy_spread: 5,
  '10y2y': 10,
  wti: 3,
  brent: 3,
  natgas: 5,
  unemployment: 2,
  fed_funds: 1,
  '10y_yield': 3,
  usd_index: 1,
  mortgage: 2,
};

const DEFAULT_COUNT_THRESHOLDS = {
  thermal_total: 500,      // ±500 detections (was 0 — +1 was noise)
  air_total: 50,           // ±50 aircraft
  who_alerts: 1,           // any new WHO alert matters
  conflict_events: 5,      // ±5 ACLED events
  conflict_fatalities: 10,  // ±10 fatalities
  sdr_online: 3,           // ±3 receivers
  news_count: 5,           // ±5 news items
  sources_ok: 1,           // any source going down matters
};

// ─── Metric Definitions ──────────────────────────────────────────────────────

const NUMERIC_METRICS = [
  { key: 'vix', extract: d => d.fred?.find(f => f.id === 'VIXCLS')?.value, label: 'VIX' },
  { key: 'hy_spread', extract: d => d.fred?.find(f => f.id === 'BAMLH0A0HYM2')?.value, label: 'HY Spread' },
  { key: '10y2y', extract: d => d.fred?.find(f => f.id === 'T10Y2Y')?.value, label: '10Y-2Y Spread' },
  { key: 'wti', extract: d => d.energy?.wti, label: 'WTI Crude' },
  { key: 'brent', extract: d => d.energy?.brent, label: 'Brent Crude' },
  { key: 'natgas', extract: d => d.energy?.natgas, label: 'Natural Gas' },
  { key: 'unemployment', extract: d => d.bls?.find(b => b.id === 'LNS14000000' || b.id === 'UNRATE')?.value, label: 'Unemployment' },
  { key: 'fed_funds', extract: d => d.fred?.find(f => f.id === 'DFF')?.value, label: 'Fed Funds Rate' },
  { key: '10y_yield', extract: d => d.fred?.find(f => f.id === 'DGS10')?.value, label: '10Y Yield' },
  { key: 'usd_index', extract: d => d.fred?.find(f => f.id === 'DTWEXBGS')?.value, label: 'USD Index' },
  { key: 'mortgage', extract: d => d.fred?.find(f => f.id === 'MORTGAGE30US')?.value, label: '30Y Mortgage' },
];

const COUNT_METRICS = [
  { key: 'thermal_total', extract: d => d.thermal?.reduce((s, t) => s + t.det, 0) || 0, label: 'Thermal Detections' },
  { key: 'air_total', extract: d => d.air?.reduce((s, a) => s + a.total, 0) || 0, label: 'Air Activity' },
  { key: 'who_alerts', extract: d => d.who?.length || 0, label: 'WHO Alerts' },
  { key: 'conflict_events', extract: d => d.acled?.totalEvents, label: 'Conflict Events' },
  { key: 'conflict_fatalities', extract: d => d.acled?.totalFatalities, label: 'Conflict Fatalities' },
  { key: 'sdr_online', extract: d => d.sdr?.online || 0, label: 'SDR Receivers' },
  { key: 'news_count', extract: d => (d.news?.length ?? d.news?.count) || 0, label: 'News Items' },
  { key: 'sources_ok', extract: d => d.meta?.sourcesOk || 0, label: 'Sources OK' },
];

const COUNT_SOURCES = { thermal_total: 'FIRMS', air_total: 'OpenSky', who_alerts: 'WHO', conflict_events: 'ACLED', conflict_fatalities: 'ACLED', sdr_online: 'KiwiSDR' };
function metricAvailable(data, key) {
  const name = COUNT_SOURCES[key];
  const health = data.health?.find(h => (h.n || h.name) === name);
  return !health || (!health.err && !health.stale);
}

// Risk-sensitive keys: used for determining overall direction
const RISK_KEYS = ['vix', 'hy_spread', 'conflict_events', 'thermal_total'];

// ─── Core Delta Computation ──────────────────────────────────────────────────

/**
 * Number of failing sources in a sweep record. Accepts either the full
 * `health` array or the `sourcesDown` count kept in compacted (stored) runs.
 */
function sourcesDownCount(data) {
  if (Array.isArray(data?.health)) return data.health.filter(s => s?.err).length;
  if (Number.isFinite(data?.sourcesDown)) return data.sourcesDown;
  return 0;
}

/**
 * @param {object} current - current sweep's synthesized data
 * @param {object|null} previous - previous sweep's synthesized data (null on first run)
 * @param {object} [thresholdOverrides] - optional: { numeric: {...}, count: {...} }
 */
export function computeDelta(current, previous, thresholdOverrides = {}) {
  if (!previous) return null;
  if (!current) return null;

  const numThresholds = { ...DEFAULT_NUMERIC_THRESHOLDS, ...(thresholdOverrides.numeric || {}) };
  const cntThresholds = { ...DEFAULT_COUNT_THRESHOLDS, ...(thresholdOverrides.count || {}) };

  const signals = { new: [], escalated: [], deescalated: [], unchanged: [] };
  let criticalChanges = 0;

  // ─── Numeric metrics: track % change ─────────────────────────────────

  for (const m of NUMERIC_METRICS) {
    const curr = m.extract(current);
    const prev = m.extract(previous);
    if (curr == null || prev == null) continue;

    const threshold = numThresholds[m.key] ?? 5;
    const pctChange = prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : 0;

    if (Math.abs(pctChange) > threshold) {
      const entry = {
        key: m.key, label: m.label, from: prev, to: curr,
        pctChange: parseFloat(pctChange.toFixed(2)),
        direction: pctChange > 0 ? 'up' : 'down',
        severity: Math.abs(pctChange) > threshold * 3 ? 'critical' : Math.abs(pctChange) > threshold * 2 ? 'high' : 'moderate',
      };
      if (pctChange > 0) signals.escalated.push(entry);
      else signals.deescalated.push(entry);
      if (Math.abs(pctChange) > 10) criticalChanges++;
    } else {
      signals.unchanged.push(m.key);
    }
  }

  // ─── Count metrics: track absolute change (with minimum thresholds) ──

  for (const m of COUNT_METRICS) {
    if (!metricAvailable(current, m.key) || !metricAvailable(previous, m.key)) continue;
    const curr = m.extract(current);
    const prev = m.extract(previous);
    if (curr == null || prev == null) continue;
    const diff = curr - prev;
    const threshold = cntThresholds[m.key] ?? 1;

    if (Math.abs(diff) >= threshold) {
      const pctChange = prev > 0 ? ((diff / prev) * 100) : (diff > 0 ? 100 : 0);
      const entry = {
        key: m.key, label: m.label, from: prev, to: curr,
        change: diff, direction: diff > 0 ? 'up' : 'down',
        pctChange: parseFloat(pctChange.toFixed(1)),
        severity: Math.abs(diff) >= threshold * 5 ? 'critical' : Math.abs(diff) >= threshold * 2 ? 'high' : 'moderate',
      };
      if (diff > 0) signals.escalated.push(entry);
      else signals.deescalated.push(entry);
      // Count metrics only critical if the change is extreme
      if (entry.severity === 'critical') criticalChanges++;
    } else {
      signals.unchanged.push(m.key);
    }
  }

  // ─── Nuclear anomaly state change ────────────────────────────────────

  const currAnom = current.nuke?.some(n => n.anom) || false;
  const prevAnom = previous.nuke?.some(n => n.anom) || false;
  if (currAnom && !prevAnom) {
    signals.new.push({ key: 'nuke_anomaly', reason: 'Nuclear anomaly detected', severity: 'critical' });
    criticalChanges += 5;
  } else if (!currAnom && prevAnom && previous.nuke.filter(n => n.anom).every(prior =>
    current.nuke?.some(n => n.site === prior.site && n.status === 'healthy' && n.anom === false))) {
    signals.deescalated.push({ key: 'nuke_anomaly', label: 'Nuclear Anomaly', direction: 'resolved', severity: 'high' });
  }

  // ─── Source health degradation ───────────────────────────────────────

  const currSourcesDown = sourcesDownCount(current);
  const prevSourcesDown = sourcesDownCount(previous);
  if (currSourcesDown > prevSourcesDown + 2) {
    signals.new.push({
      key: 'source_degradation',
      reason: `${currSourcesDown - prevSourcesDown} additional sources failing (${currSourcesDown} total down)`,
      severity: currSourcesDown > 5 ? 'critical' : 'moderate',
    });
  }

  // ─── Overall direction ───────────────────────────────────────────────

  let direction = 'mixed';
  const riskUp = signals.escalated.filter(s => RISK_KEYS.includes(s.key)).length;
  const riskDown = signals.deescalated.filter(s => RISK_KEYS.includes(s.key)).length;
  if (riskUp > riskDown + 1) direction = 'risk-off';
  else if (riskDown > riskUp + 1) direction = 'risk-on';

  return {
    timestamp: current.meta?.timestamp || new Date().toISOString(),
    previous: previous.meta?.timestamp || null,
    signals,
    summary: {
      totalChanges: signals.new.length + signals.escalated.length + signals.deescalated.length,
      criticalChanges,
      direction,
      signalBreakdown: {
        new: signals.new.length,
        escalated: signals.escalated.length,
        deescalated: signals.deescalated.length,
        unchanged: signals.unchanged.length,
      },
    },
  };
}

// Export thresholds for external config
export { DEFAULT_NUMERIC_THRESHOLDS, DEFAULT_COUNT_THRESHOLDS };
