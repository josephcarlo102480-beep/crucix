import { createHash } from 'crypto';

export const ALERT_RATE_LIMITS = {
  FLASH: { cooldownMs: 5 * 60 * 1000, maxPerHour: 6 },
  PRIORITY: { cooldownMs: 30 * 60 * 1000, maxPerHour: 4 },
  ROUTINE: { cooldownMs: 60 * 60 * 1000, maxPerHour: 2 },
};

export function getNewSignals(delta, memory, contentHashes, prefix) {
  const allSignals = [
    ...(delta.signals?.new || []),
    ...(delta.signals?.escalated || []),
  ];

  return allSignals.filter((signal) => {
    const key = signalKey(signal, prefix);
    if (typeof memory.isSignalSuppressed === 'function') {
      if (memory.isSignalSuppressed(key)) return false;
    } else if (memory.getAlertedSignals?.()?.[key]) {
      return false;
    }

    return !isSemanticDuplicate(contentHashes, signal);
  });
}

export async function evaluateAlertDecision({ llmProvider, signals, delta, logLabel }) {
  let evaluation = null;

  if (llmProvider?.isConfigured) {
    try {
      const result = await llmProvider.complete(
        buildEvaluationPrompt(),
        buildSignalContext(signals, delta),
        { maxTokens: 800, timeout: 30000 },
      );
      evaluation = parseAlertJSON(result.text);
    } catch (err) {
      console.warn(`[${logLabel}] LLM evaluation failed, falling back to rules:`, err.message);
    }
  }

  if (!evaluation || typeof evaluation.shouldAlert !== 'boolean') {
    evaluation = ruleBasedEvaluation(signals, delta);
    if (evaluation) evaluation._source = 'rules';
  }

  return evaluation;
}

export function ruleBasedEvaluation(signals, delta) {
  const criticals = signals.filter((s) => s.severity === 'critical');
  const highs = signals.filter((s) => s.severity === 'high');
  const nukeSignal = signals.find((s) => s.key === 'nuke_anomaly');
  const osintNew = signals.filter((s) => s.key?.startsWith('tg_urgent'));
  const marketSignals = signals.filter((s) => ['vix', 'hy_spread', 'wti', 'brent', '10y2y'].includes(s.key));
  const conflictSignals = signals.filter((s) => ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key));

  if (nukeSignal) {
    return {
      shouldAlert: true,
      tier: 'FLASH',
      confidence: 'HIGH',
      headline: 'Nuclear Anomaly Detected',
      reason: 'Safecast radiation monitors have flagged an anomaly. This requires immediate attention.',
      actionable: 'Check dashboard for affected sites. Monitor confirmation from secondary sources.',
      signals: ['nuke_anomaly'],
      crossCorrelation: 'radiation monitors',
    };
  }

  const hasCriticalMarket = criticals.some((s) => marketSignals.includes(s));
  const hasCriticalConflict = criticals.some((s) => conflictSignals.includes(s) || osintNew.includes(s));
  if (criticals.length >= 2 && hasCriticalMarket && hasCriticalConflict) {
    return {
      shouldAlert: true,
      tier: 'FLASH',
      confidence: 'HIGH',
      headline: `${criticals.length} Critical Cross-Domain Signals`,
      reason: `${criticals.length} critical signals detected across market and conflict domains. Multi-domain correlation suggests systemic event.`,
      actionable: 'Review dashboard immediately. Assess portfolio exposure.',
      signals: criticals.map((s) => s.label || s.key).slice(0, 5),
      crossCorrelation: 'market + conflict',
    };
  }

  const escalatedHighs = [...criticals, ...highs].filter((s) => s.direction === 'up');
  if (escalatedHighs.length >= 2) {
    return {
      shouldAlert: true,
      tier: 'PRIORITY',
      confidence: 'MEDIUM',
      headline: `${escalatedHighs.length} Escalating Signals`,
      reason: `Multiple indicators escalating simultaneously: ${escalatedHighs.map((s) => s.label || s.key).slice(0, 3).join(', ')}.`,
      actionable: 'Monitor for continuation. Check if trend persists in next sweep.',
      signals: escalatedHighs.map((s) => s.label || s.key).slice(0, 5),
      crossCorrelation: 'multi-indicator',
    };
  }

  if (osintNew.length >= 5) {
    return {
      shouldAlert: true,
      tier: 'PRIORITY',
      confidence: 'MEDIUM',
      headline: `OSINT Surge: ${osintNew.length} New Urgent Posts`,
      reason: `${osintNew.length} new urgent OSINT signals detected. Elevated conflict reporting tempo.`,
      actionable: 'Review OSINT stream for pattern. Cross-check with satellite and ACLED data.',
      signals: osintNew.map((s) => s.text || s.label || s.key).slice(0, 5),
      crossCorrelation: 'telegram OSINT',
    };
  }

  if (criticals.length >= 1 || highs.length >= 3) {
    const topSignal = criticals[0] || highs[0];
    return {
      shouldAlert: true,
      tier: 'ROUTINE',
      confidence: 'LOW',
      headline: topSignal.label || topSignal.reason || 'Signal Change Detected',
      reason: `${criticals.length} critical, ${highs.length} high-severity signals. ${delta.summary.direction} bias.`,
      actionable: 'Monitor',
      signals: [...criticals, ...highs].map((s) => s.label || s.key).slice(0, 4),
      crossCorrelation: 'single-domain',
    };
  }

  return {
    shouldAlert: false,
    reason: `${signals.length} signals, but none meet alert threshold (${criticals.length} critical, ${highs.length} high).`,
  };
}

export function buildEvaluationPrompt() {
  return `You are Crucix, an elite intelligence alert evaluator for a personal OSINT monitoring system. You analyze signal deltas from a 29-source intelligence sweep and decide if the user needs to be alerted via Telegram.

## Your Decision Framework

You must classify each evaluation into one of four outcomes:

### NO ALERT — suppress if:
- Routine scheduled data (NFP, CPI, FOMC minutes on expected dates) UNLESS the deviation from consensus is extreme (>2σ)
- Continuation of existing trends already flagged in prior sweeps
- Low-confidence signals from single sources without corroboration
- Social media noise without hard-data confirmation (Telegram chatter alone is NOT enough)

### 🔴 FLASH — immediate, life-of-portfolio risk:
- Active military escalation between nuclear powers or NATO-involved states
- Flash crash indicators (VIX spike >40%, major index down >3% intraday)
- Central bank emergency action (unscheduled rate decision, emergency lending facility)
- Nuclear/radiological anomaly confirmed by multiple monitors
- Sanctions against major economy announced without warning
FLASH requires: ≥2 corroborating sources across different domains (e.g. OSINT + market data + satellite)

### 🟡 PRIORITY — act within hours:
- Significant market dislocation (VIX >25 AND credit spreads widening)
- Geopolitical escalation with clear energy/commodity transmission (conflict + oil move >3%)
- Unexpected economic data (>1.5σ miss on major indicator)
- New conflict front or ceasefire collapse confirmed by ACLED + Telegram
PRIORITY requires: ≥2 signals moving in same direction, at least 1 from hard data

### 🔵 ROUTINE — informational, no urgency:
- Notable trend shifts or reversals worth tracking
- Single-source signals of moderate importance
- Cumulative drift (multiple small moves in same direction over several sweeps)

## Output Format

Respond with ONLY valid JSON:
{
  "shouldAlert": true/false,
  "tier": "FLASH" | "PRIORITY" | "ROUTINE",
  "headline": "10-word max headline",
  "reason": "2-3 sentences. What happened, why it matters, what to watch next.",
  "actionable": "Specific action the user could take (or 'Monitor' if just informational)",
  "signals": ["signal1", "signal2"],
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "crossCorrelation": "Which domains are confirming each other (e.g. 'conflict + energy + satellite')"
}`;
}

export function buildSignalContext(signals, delta) {
  const sections = [];
  const marketSignals = signals.filter((s) => ['vix', 'hy_spread', 'wti', 'brent', 'natgas', '10y2y', 'fed_funds', '10y_yield', 'usd_index'].includes(s.key));
  const osintSignals = signals.filter((s) => s.key === 'tg_urgent' || s.item?.channel);
  const conflictSignals = signals.filter((s) => ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key));
  const otherSignals = signals.filter((s) => !marketSignals.includes(s) && !osintSignals.includes(s) && !conflictSignals.includes(s));

  if (marketSignals.length > 0) {
    sections.push('📊 MARKET SIGNALS:\n' + marketSignals.map((s) =>
      `  ${s.label}: ${s.from} → ${s.to} (${s.pctChange > 0 ? '+' : ''}${s.pctChange?.toFixed(1) || s.change}${s.pctChange !== undefined ? '%' : ''})`,
    ).join('\n'));
  }

  if (osintSignals.length > 0) {
    sections.push('📡 OSINT SIGNALS:\n' + osintSignals.map((s) => {
      const post = s.item || s;
      return `  [${post.channel || 'UNKNOWN'}] ${post.text || s.reason || ''}`;
    }).join('\n'));
  }

  if (conflictSignals.length > 0) {
    sections.push('⚔️ CONFLICT INDICATORS:\n' + conflictSignals.map((s) =>
      `  ${s.label}: ${s.from} → ${s.to} (${s.direction})`,
    ).join('\n'));
  }

  if (otherSignals.length > 0) {
    sections.push('📌 OTHER:\n' + otherSignals.map((s) =>
      `  ${s.label || s.key || s.reason}: ${s.from !== undefined ? `${s.from} → ${s.to}` : 'new signal'}`,
    ).join('\n'));
  }

  sections.push(`\n📈 SWEEP DELTA: direction=${delta.summary.direction}, total=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
  return sections.join('\n\n');
}

export function contentHash(signal) {
  let content = '';
  if (signal.text) {
    content = signal.text.toLowerCase()
      .replace(/\d{1,2}:\d{2}/g, '')
      .replace(/\d+\.\d+%?/g, 'NUM')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 120);
  } else if (signal.label) {
    content = `${signal.label}:${signal.direction || 'none'}`;
  } else {
    content = signal.key || JSON.stringify(signal).substring(0, 80);
  }

  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

export function isSemanticDuplicate(contentHashes, signal) {
  const hash = contentHash(signal);
  const lastSeen = contentHashes[hash];
  if (!lastSeen) return false;
  return new Date(lastSeen).getTime() > (Date.now() - 4 * 60 * 60 * 1000);
}

export function recordContentHash(contentHashes, signal) {
  const hash = contentHash(signal);
  contentHashes[hash] = new Date().toISOString();

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, timestamp] of Object.entries(contentHashes)) {
    if (new Date(timestamp).getTime() < cutoff) delete contentHashes[key];
  }
}

export function signalKey(signal, prefix = 'alert') {
  if (signal.text) return `${prefix}:${contentHash(signal)}`;
  return signal.key || signal.label || JSON.stringify(signal).substring(0, 60);
}

export function checkRateLimit(alertHistory, tier) {
  const config = ALERT_RATE_LIMITS[tier];
  if (!config) return true;

  const now = Date.now();
  const lastSameTier = alertHistory.filter((alert) => alert.tier === tier).pop();
  if (lastSameTier && (now - lastSameTier.timestamp) < config.cooldownMs) return false;

  const oneHourAgo = now - 60 * 60 * 1000;
  const recentCount = alertHistory.filter((alert) => alert.tier === tier && alert.timestamp > oneHourAgo).length;
  return recentCount < config.maxPerHour;
}

export function recordAlert(alertHistory, tier) {
  alertHistory.push({ tier, timestamp: Date.now() });
  if (alertHistory.length > 50) {
    alertHistory.splice(0, alertHistory.length - 50);
  }
}

export function parseAlertJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
