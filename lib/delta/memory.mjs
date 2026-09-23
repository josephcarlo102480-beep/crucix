// Memory Manager — hot/cold storage for sweep history and alert tracking
// v2: Atomic writes, decay-based alert cooldowns, configurable retention

import { readdirSync, unlinkSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { atomicWriteJsonSync, readJsonSync } from '../util/fs.mjs';
import { computeDelta } from './engine.mjs';

const MAX_HOT_RUNS = 3;
const DEFAULT_COLD_RETENTION_DAYS = 30;

// Alert cooldown tiers — repeated signals get progressively longer suppression
// First alert: 0h wait. Second occurrence within 24h: 6h cooldown. Third: 12h. Fourth+: 24h.
const ALERT_DECAY_TIERS = [0, 6, 12, 24]; // hours

export class MemoryManager {
  constructor(runsDir, {
    thresholds = {},
    maxBaselineAgeMs = Number.POSITIVE_INFINITY,
    coldRetentionDays = DEFAULT_COLD_RETENTION_DAYS,
  } = {}) {
    this.runsDir = runsDir;
    this.thresholds = thresholds;
    this.maxBaselineAgeMs = maxBaselineAgeMs;
    this.coldRetentionDays = coldRetentionDays;
    this.memoryDir = join(runsDir, 'memory');
    this.hotPath = join(this.memoryDir, 'hot.json');
    this.coldDir = join(this.memoryDir, 'cold');

    // Ensure dirs exist
    for (const dir of [this.memoryDir, this.coldDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    // Load hot memory from disk
    this.hot = this._loadHot();
  }

  _loadHot() {
    // Try primary file first, then backup
    for (const path of [this.hotPath, this.hotPath + '.bak']) {
      const data = readJsonSync(path, null);
      // Validate structure. `typeof null === 'object'`, so alertedSignals must
      // be checked explicitly or every lookup below throws.
      if (!data || !Array.isArray(data.runs)) continue;
      if (data.alertedSignals === null || typeof data.alertedSignals !== 'object' || Array.isArray(data.alertedSignals)) {
        data.alertedSignals = {};
      }
      return data;
    }
    console.warn('[Memory] No valid hot memory found — starting fresh');
    return { runs: [], alertedSignals: {} };
  }

  /**
   * Atomic write (temp file + fsync + rename, via lib/util/fs).
   * Keeps a .bak of the previous version for crash recovery.
   */
  _saveHot() {
    const bakPath = this.hotPath + '.bak';
    try {
      // Back up the current file first — the atomic write replaces it in one step.
      try {
        if (existsSync(this.hotPath)) renameSync(this.hotPath, bakPath);
      } catch { /* backup failure is non-fatal */ }

      atomicWriteJsonSync(this.hotPath, this.hot, { pretty: true });
    } catch (err) {
      console.error('[Memory] Failed to save hot memory:', err.message);
    }
  }

  // Add a new run to hot memory
  addRun(synthesizedData) {
    const previous = this.getLastRun();
    const baselineAgeMs = this._baselineAgeMs(synthesizedData, previous);
    const policyChanged = previous && previous.meta?.dataQualityVersion !== synthesizedData.meta?.dataQualityVersion;
    const baselineIsStale = baselineAgeMs > this.maxBaselineAgeMs || policyChanged;
    const delta = baselineIsStale
      ? this._baselineResetDelta(synthesizedData, previous, baselineAgeMs)
      : computeDelta(synthesizedData, previous, this.thresholds);
    if (policyChanged) delta.baselineResetReason = 'Data-quality rules updated. Comparison resumes with the next sweep.';

    // Compact the data for storage (strip large arrays)
    const compact = this._compactForStorage(synthesizedData);

    this.hot.runs.unshift({
      timestamp: synthesizedData.meta?.timestamp || new Date().toISOString(),
      data: compact,
      delta,
    });

    // Keep only MAX_HOT_RUNS
    if (this.hot.runs.length > MAX_HOT_RUNS) {
      const archived = this.hot.runs.splice(MAX_HOT_RUNS);
      this._archiveToCold(archived);
    }

    this._saveHot();
    return delta;
  }

  _baselineAgeMs(current, previous) {
    if (!previous) return 0;
    const currentTime = new Date(current?.meta?.timestamp || Date.now()).getTime();
    const previousTime = new Date(previous?.meta?.timestamp || 0).getTime();
    if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime)) return Number.POSITIVE_INFINITY;
    return Math.max(0, currentTime - previousTime);
  }

  _baselineResetDelta(current, previous, baselineAgeMs) {
    return {
      timestamp: current?.meta?.timestamp || new Date().toISOString(),
      previous: previous?.meta?.timestamp || null,
      baselineReset: true,
      baselineAgeMs,
      signals: { new: [], escalated: [], deescalated: [], unchanged: [] },
      summary: {
        totalChanges: 0,
        criticalChanges: 0,
        direction: 'mixed',
        baselineReset: true,
        signalBreakdown: { new: 0, escalated: 0, deescalated: 0, unchanged: 0 },
      },
    };
  }

  // Get last run's synthesized data
  getLastRun() {
    if (this.hot.runs.length === 0) return null;
    return this.hot.runs[0].data;
  }

  // Get last N runs
  getRunHistory(n = 3) {
    return this.hot.runs.slice(0, n);
  }

  // Get the delta from the most recent run
  getLastDelta() {
    if (this.hot.runs.length === 0) return null;
    return this.hot.runs[0].delta;
  }

  updateLastRunIdeas(ideas = []) {
    if (this.hot.runs.length === 0) return;
    this.hot.runs[0].data.ideas = this._compactIdeas(ideas);
    this._saveHot();
  }

  // ─── Alert Signal Tracking (Decay-Based) ───────────────────────────────

  getAlertedSignals() {
    return this.hot.alertedSignals || {};
  }

  /**
   * Check if a signal should be suppressed based on decay-based cooldown.
   * Returns true if the signal is still in cooldown.
   */
  isSignalSuppressed(signalKey) {
    const entry = this.hot.alertedSignals[signalKey];
    if (!entry) return false;

    const now = Date.now();
    const occurrences = typeof entry === 'object' ? (entry.count || 1) : 1;
    const lastAlerted = typeof entry === 'object' ? new Date(entry.lastAlerted).getTime() : new Date(entry).getTime();

    // Pick cooldown tier based on how many times this signal has fired
    const tierIndex = Math.min(occurrences, ALERT_DECAY_TIERS.length - 1);
    const cooldownHours = ALERT_DECAY_TIERS[tierIndex];
    const cooldownMs = cooldownHours * 60 * 60 * 1000;

    return (now - lastAlerted) < cooldownMs;
  }

  /**
   * Mark a signal as alerted, incrementing its occurrence counter.
   * Supports both legacy (string timestamp) and new (object with count) formats.
   *
   * @param {string} signalKey
   * @param {string} [timestamp]
   * @param {{ save?: boolean }} [opts] pass `{ save: false }` to batch several
   *        marks behind a single write (see markManyAsAlerted).
   */
  markAsAlerted(signalKey, timestamp, { save = true } = {}) {
    const now = timestamp || new Date().toISOString();
    const existing = this.hot.alertedSignals[signalKey];

    if (existing && typeof existing === 'object') {
      // Increment existing
      existing.count = (existing.count || 1) + 1;
      existing.lastAlerted = now;
      existing.firstSeen = existing.firstSeen || now;
    } else {
      // New entry (or migrate from legacy string format)
      this.hot.alertedSignals[signalKey] = {
        firstSeen: typeof existing === 'string' ? existing : now,
        lastAlerted: now,
        count: typeof existing === 'string' ? 2 : 1,
      };
    }
    if (save) this._saveHot();
  }

  /**
   * Mark several signal keys as alerted, writing hot memory once.
   * @param {string[]} signalKeys
   * @param {string} [timestamp]
   */
  markManyAsAlerted(signalKeys = [], timestamp) {
    const keys = Array.isArray(signalKeys) ? signalKeys : [signalKeys];
    if (keys.length === 0) return;
    const now = timestamp || new Date().toISOString();
    for (const key of keys) this.markAsAlerted(key, now, { save: false });
    this._saveHot();
  }

  /**
   * Prune stale alerted signals.
   * Signals with 1 occurrence: pruned after 24h.
   * Signals with 2+ occurrences: pruned after 48h from last alert.
   * This prevents infinite accumulation while keeping recurring signal awareness.
   */
  pruneAlertedSignals() {
    const now = Date.now();
    for (const [key, entry] of Object.entries(this.hot.alertedSignals)) {
      let lastTime, count;

      if (typeof entry === 'object') {
        lastTime = new Date(entry.lastAlerted).getTime();
        count = entry.count || 1;
      } else {
        // Legacy string format
        lastTime = new Date(entry).getTime();
        count = 1;
      }

      const maxAge = count >= 2 ? 48 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      if ((now - lastTime) > maxAge) {
        delete this.hot.alertedSignals[key];
      }
    }
    this._saveHot();
  }

  // Compact data for storage — strip heavy arrays
  _compactForStorage(data) {
    // Source health has to survive compaction: the delta engine's
    // source_degradation signal diffs it against the previous run, and without
    // it every sweep looked like a fresh degradation.
    const health = (data.health || []).map(h => ({ n: h.n || h.name, status: h.status, err: Boolean(h.err), stale: Boolean(h.stale) }));
    return {
      meta: data.meta,
      fred: data.fred,
      energy: data.energy,
      bls: data.bls,
      treasury: data.treasury,
      gscpi: data.gscpi,
      health,
      sourcesDown: health.filter(h => h.err).length,
      thermal: (data.thermal || []).map(t => ({ region: t.region, det: t.det, night: t.night, hc: t.hc })),
      air: (data.air || []).map(a => ({ region: a.region, total: a.total })),
      nuke: (data.nuke || []).map(n => ({ site: n.site, anom: n.anom, cpm: n.cpm, status: n.status, lastReading: n.lastReading })),
      radBackground: {
        anomaly: typeof data.radBackground?.anomaly === 'boolean' ? data.radBackground.anomaly : null,
        medianUSvH: data.radBackground?.medianUSvH ?? null,
        networks: (data.radBackground?.networks || []).map(n => ({ network: n.network, medianUSvH: n.medianUSvH ?? null })),
      },
      who: (data.who || []).map(w => ({ title: w.title })),
      acled: { totalEvents: data.acled?.totalEvents, totalFatalities: data.acled?.totalFatalities },
      sdr: { total: data.sdr?.total, online: data.sdr?.online },
      news: { count: data.news?.length || 0 },
      ideas: this._compactIdeas(data.ideas),
    };
  }

  _compactIdeas(ideas = []) {
    return (ideas || []).map(i => ({ title: i.title, type: i.type, confidence: i.confidence }));
  }

  // Archive old runs to cold storage
  _archiveToCold(runs) {
    if (runs.length === 0) return;
    const dateKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const coldPath = join(this.coldDir, `${dateKey}.json`);

    // A cold file that parsed to something other than an array (corruption, or
    // an older format) must not take addRun down with it — start the day over.
    const parsed = readJsonSync(coldPath, []);
    const existing = Array.isArray(parsed) ? parsed : [];

    existing.push(...runs);
    try {
      atomicWriteJsonSync(coldPath, existing, { pretty: true });
    } catch (err) {
      console.error('[Memory] Failed to archive to cold storage:', err.message);
    }

    this._pruneColdStorage();
  }

  /** Delete cold files older than `coldRetentionDays`. */
  _pruneColdStorage() {
    const days = Number(this.coldRetentionDays);
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = Date.now() - days * 86400000;

    let files;
    try {
      files = readdirSync(this.coldDir);
    } catch {
      return;
    }

    for (const file of files) {
      const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
      if (!match) continue;
      const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (!Number.isFinite(fileTime) || fileTime >= cutoff) continue;
      try {
        unlinkSync(join(this.coldDir, file));
      } catch { /* best effort */ }
    }
  }
}
