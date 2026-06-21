// Ask AI — grounded Q&A over the current dashboard plus optional OpenAI web search

import {
  getSatellitePassContext,
  questionNeedsSatellitePassContext,
} from '../space/satellitePasses.mjs';

const MAX_QUESTION_CHARS = 1200;
const ASK_AI_OPTIONS = {
  maxTokens: 8000,
  timeout: 150000,
  reasoningEffort: 'high',
  verbosity: 'high',
  searchContextSize: 'high',
};

// Ask AI sends the FULL current dashboard data model to the LLM. These "full"
// limits are high enough that a normal sweep passes through untouched — they only
// guard against a single pathological field (e.g. a multi-megabyte blob).
const FULL_LIMITS = { stringMax: 20000, deepStringMax: 20000, arrayMax: 100000, deepArrayMax: 100000 };

// If the full snapshot would blow the model's context window, fall back to these
// tighter limits so the feature degrades gracefully instead of erroring out.
const CONDENSED_LIMITS = { stringMax: 900, deepStringMax: 240, arrayMax: 60, deepArrayMax: 20 };

// Overall character budget for the serialized snapshot. A normal synthesized
// sweep serializes to ~200-300KB, so the default leaves generous headroom.
// Override with ASK_AI_MAX_CONTEXT_CHARS for a smaller/larger model context.
const MAX_CONTEXT_CHARS = Math.max(50000, parseInt(process.env.ASK_AI_MAX_CONTEXT_CHARS || '', 10) || 900000);

export function validateAskQuestion(question) {
  const text = String(question || '').trim();
  if (!text) return { ok: false, error: 'Question is required.' };
  if (text.length > MAX_QUESTION_CHARS) {
    return { ok: false, error: `Question is too long. Keep it under ${MAX_QUESTION_CHARS} characters.` };
  }
  return { ok: true, question: text };
}

export async function answerDashboardQuestion(provider, dashboardData, question, rawData = null) {
  const validation = validateAskQuestion(question);
  if (!validation.ok) throw new Error(validation.error);

  const { dashboard, raw, condensed } = buildAskContext(dashboardData, rawData);
  const satellitePassContext = await maybeGetSatellitePassContext(validation.question);
  const systemPrompt = `You are Crucix Ask AI, an intelligence analyst inside the Crucix dashboard.

You may use these evidence layers:
1. CURRENT_CRUCIX_DASHBOARD_SNAPSHOT: the synthesized view Crucix displays — authoritative for currently displayed values, computed cross-source signals, sweep deltas, ideas, and source health.
2. RAW_SOURCE_DATA, when present: the complete unsynthesized output from every source in the latest sweep. This is the most granular layer — use it for full detail, complete lists, and fields not surfaced in the snapshot. The snapshot is derived from this same raw data.
3. SATELLITE_PASS_CONTEXT, when present: authoritative for local satellite pass calculations in Crucix.
4. Your general model knowledge.
5. Web search, when current public information would improve the answer.

Quality bar:
- Answer the user's question directly, with a clear bottom line first.
- Tie claims to specific dashboard fields, values, timestamps, source names, or visible items whenever available.
- If the user asks what matters, rank the strongest 3-5 signals and explain why each one matters.
- Distinguish dashboard facts from your inference and from web-sourced context.
- Prefer the dashboard snapshot for current Crucix values, counts, signals, ideas, and source status.
- Use RAW_SOURCE_DATA when the user needs full detail, complete lists, or fields beyond what the snapshot shows; the snapshot and raw data describe the same sweep, so reach for raw for granularity and the snapshot for computed signals, deltas, and ideas.
- For local satellite visibility/pass questions, prefer SATELLITE_PASS_CONTEXT over web search and state that geometric visibility is not the same as naked-eye optical visibility.
- Use web search for current outside context, recent events, definitions, or verification beyond the dashboard.
- If web results and dashboard data disagree, state the difference and reference timestamps.
- Do not invent unavailable metrics. Say what is missing.
- Cite web-sourced claims through returned citations. For dashboard-only claims, cite the dashboard timestamp or source names in prose.
- Avoid generic restatements. Produce useful synthesis, implications, caveats, and confidence where appropriate.
- This is informational intelligence support, not financial, legal, or safety advice.`;

  const snapshotNote = condensed
    ? ' (NOTE: this sweep exceeded the context budget and was condensed — some long text and list tails were trimmed.)'
    : ' (complete current dashboard data model)';

  const userPrompt = `QUESTION:
${validation.question}

CURRENT_CRUCIX_DASHBOARD_SNAPSHOT:${snapshotNote}
${JSON.stringify(dashboard, null, 2)}

RAW_SOURCE_DATA:${raw ? ' (full unsynthesized output from every source in the latest sweep — most granular layer)' : ''}
${raw ? JSON.stringify(raw, null, 2) : 'Not available for this request.'}

SATELLITE_PASS_CONTEXT:
${satellitePassContext ? JSON.stringify(satellitePassContext, null, 2) : 'Not requested or unavailable for this question.'}`;

  const result = await provider.complete(systemPrompt, userPrompt, {
    maxTokens: ASK_AI_OPTIONS.maxTokens,
    timeout: ASK_AI_OPTIONS.timeout,
    reasoningEffort: ASK_AI_OPTIONS.reasoningEffort,
    verbosity: ASK_AI_OPTIONS.verbosity,
    webSearch: true,
    searchContextSize: ASK_AI_OPTIONS.searchContextSize,
  });

  return {
    answer: result.text || '',
    citations: result.citations || [],
    webSearches: result.webSearches || [],
    model: result.model,
    usage: result.usage,
    generatedAt: new Date().toISOString(),
    dashboardTimestamp: dashboardData?.meta?.timestamp || null,
  };
}

async function maybeGetSatellitePassContext(question) {
  if (!questionNeedsSatellitePassContext(question)) return null;

  try {
    return await getSatellitePassContext(question);
  } catch (err) {
    return {
      source: 'Crucix satellite tracker TLE pass calculation',
      error: err?.message || 'Satellite pass calculation failed',
    };
  }
}

// Build the full context sent to the LLM: the synthesized dashboard snapshot plus
// the raw unsynthesized sweep (when available). Sends everything at full fidelity
// and only condenses — or, as a last resort, drops the raw layer — if the combined
// payload would exceed the context budget.
function buildAskContext(dashboardData, rawData) {
  const size = (value) => (value == null ? 0 : JSON.stringify(value, null, 2).length);

  // 1. Try every layer at full fidelity.
  const dashFull = compactDashboardForAsk(dashboardData, FULL_LIMITS);
  const rawFull = rawData != null ? sanitizeForLLM(rawData, FULL_LIMITS) : null;
  if (size(dashFull) + size(rawFull) <= MAX_CONTEXT_CHARS) {
    return { dashboard: dashFull, raw: rawFull, condensed: false };
  }

  // 2. Condense both layers.
  const dashSmall = compactDashboardForAsk(dashboardData, CONDENSED_LIMITS);
  const rawSmall = rawData != null ? sanitizeForLLM(rawData, CONDENSED_LIMITS) : null;
  if (size(dashSmall) + size(rawSmall) <= MAX_CONTEXT_CHARS) {
    return { dashboard: dashSmall, raw: rawSmall, condensed: true };
  }

  // 3. Last resort: keep the condensed snapshot, drop the raw layer.
  return { dashboard: dashSmall, raw: null, condensed: true };
}

export function compactDashboardForAsk(data = {}, limits = FULL_LIMITS) {
  const grouped = {
    meta: data.meta,
    sourceHealth: data.health,
    sweepDelta: data.delta,
    crossSourceSignals: data.tSignals,
    ideas: data.ideas,
    ideasSource: data.ideasSource,
    markets: data.markets,
    macro: {
      fred: data.fred,
      bls: data.bls,
      treasury: data.treasury,
      gscpi: data.gscpi,
      energy: data.energy,
    },
    osint: {
      telegram: data.tg,
      newsFeed: data.newsFeed,
      mappedNews: data.news,
      who: data.who,
      gdelt: data.gdelt,
    },
    mapLayers: {
      air: data.air,
      airMeta: data.airMeta,
      thermal: data.thermal,
      chokepoints: data.chokepoints,
      nuclear: data.nuke,
      nuclearSignals: data.nukeSignals,
      epa: data.epa,
      noaa: data.noaa,
      sdr: data.sdr,
      space: data.space,
      acled: data.acled,
      defense: data.defense,
    },
  };

  // Future-proofing: surface any top-level dashboard fields not explicitly
  // grouped above so the AI always sees the complete data model, even if new
  // sources/fields are added to the synthesized output later.
  const groupedKeys = new Set([
    'meta', 'health', 'delta', 'tSignals', 'ideas', 'ideasSource', 'markets',
    'fred', 'bls', 'treasury', 'gscpi', 'energy',
    'tg', 'newsFeed', 'news', 'who', 'gdelt',
    'air', 'airMeta', 'thermal', 'chokepoints', 'nuke', 'nukeSignals',
    'epa', 'noaa', 'sdr', 'space', 'acled', 'defense',
  ]);
  const additional = {};
  for (const [key, value] of Object.entries(data)) {
    if (!groupedKeys.has(key)) additional[key] = value;
  }
  if (Object.keys(additional).length > 0) grouped.additional = additional;

  return sanitizeForLLM(grouped, limits);
}

function sanitizeForLLM(value, limits = FULL_LIMITS, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return truncate(value, depth > 4 ? limits.deepStringMax : limits.stringMax);
  }
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const max = depth <= 2 ? limits.arrayMax : limits.deepArrayMax;
    return value.slice(0, max).map(item => sanitizeForLLM(item, limits, depth + 1));
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue;
    out[key] = sanitizeForLLM(item, limits, depth + 1);
  }
  return out;
}

function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}
