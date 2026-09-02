// UN Comtrade — Global Trade Data
// Public preview endpoint requires no key. Full API needs free registration.
// Tracks commodity trade flows between nations: crude oil, gas, gold, semiconductors, arms.
// Reporter codes: 842 (US), 156 (China), 276 (Germany), 392 (Japan), 826 (UK), 643 (Russia), 356 (India)

import { delay, safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://comtradeapi.un.org/public/v1';

// Strategic commodity codes (HS classification)
const STRATEGIC_COMMODITIES = {
  '2709': 'Crude Petroleum',
  '2711': 'Natural Gas (LNG & Pipeline)',
  '7108': 'Gold (unwrought/semi-manufactured)',
  '8542': 'Semiconductors (Electronic Integrated Circuits)',
  '93':   'Arms & Ammunition',
  '2844': 'Radioactive Elements (Nuclear)',
  '8471': 'Computers & Processing Units',
  '2701': 'Coal',
  '7601': 'Aluminium (unwrought)',
  '2612': 'Uranium & Thorium Ores',
};

// Key reporter/partner country codes
const COUNTRIES = {
  842: 'United States',
  156: 'China',
  276: 'Germany',
  392: 'Japan',
  826: 'United Kingdom',
  643: 'Russia',
  356: 'India',
  410: 'South Korea',
  158: 'Taiwan',
  380: 'Italy',
};

// Comtrade is slow and the sweep kills a source at 30s, so single attempts are
// kept short and the briefing fans out with a small concurrency limit.
const REQUEST_TIMEOUT_MS = 6000;
// The keyless preview endpoint rate-limits hard ("Rate limit is exceeded. Try
// again in 2 seconds"): four workers in parallel 429'd half the pairs. One
// request in flight, spaced REQUEST_GAP_MS apart, with a single Retry-After
// aware retry from safeFetch.
const CONCURRENCY = 1;
const REQUEST_GAP_MS = 1100;
// Leave headroom inside the 30s source budget for the optional second-year pass.
const BUDGET_MS = 22_000;

// Get trade data for a specific reporter, commodity, and period
export async function getTradeData(opts = {}) {
  const {
    reporterCode = 842,        // default: US
    period = new Date().getFullYear(),
    cmdCode = '2709',          // default: crude oil
    flowCode = 'M',            // M = imports, X = exports
    partnerCode = null,        // null = all partners
    signal,
  } = opts;

  const params = new URLSearchParams({
    reporterCode: String(reporterCode),
    period: String(period),
    cmdCode,
    flowCode,
  });
  if (partnerCode) params.set('partnerCode', String(partnerCode));

  return safeFetch(`${BASE}/preview/C/A/HS?${params}`, {
    timeout: REQUEST_TIMEOUT_MS,
    retries: 1,
    signal,
  });
}

// Pull `records` out of whichever envelope Comtrade used, or report the failure.
function readRecords(data) {
  if (!data || data.error) return { error: data?.error || 'Comtrade returned no response' };
  if (data.rawText !== undefined) {
    return { error: `Comtrade returned a non-JSON body: ${String(data.rawText).slice(0, 120)}` };
  }
  const records = data.data || data.dataset;
  if (!Array.isArray(records)) return { error: 'Comtrade response had no data array' };
  return { records };
}

// Run `fn` over `items` at most `limit` at a time, preserving input order.
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      if (i > 0 && REQUEST_GAP_MS > 0) await delay(REQUEST_GAP_MS);
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.allSettled(workers);
  return out;
}

// Get bilateral trade between two countries for a commodity
export async function getBilateralTrade(reporter, partner, cmdCode, period) {
  return getTradeData({
    reporterCode: reporter,
    partnerCode: partner,
    cmdCode,
    period: period || new Date().getFullYear(),
  });
}

// Compact a trade record for briefing output
function compactRecord(rec) {
  return {
    reporter: rec.reporterDesc || rec.reporterCode,
    partner: rec.partnerDesc || rec.partnerCode,
    commodity: rec.cmdDesc || rec.cmdCode,
    flow: rec.flowDesc || rec.flowCode,
    value: rec.primaryValue || rec.cifvalue || rec.fobvalue || null,
    quantity: rec.qty || rec.netWgt || null,
    unit: rec.qtyUnitAbbr || rec.qtyUnitDesc || null,
    period: rec.period,
  };
}

// Detect anomalies in trade data (unusually large flows, new partners, etc.)
function detectAnomalies(tradeRecords) {
  const signals = [];
  if (!Array.isArray(tradeRecords) || tradeRecords.length === 0) return signals;

  const values = tradeRecords
    .map(r => r.value)
    .filter(v => typeof v === 'number' && v > 0);

  if (values.length > 2) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((a, v) => a + (v - avg) ** 2, 0) / values.length);

    tradeRecords.forEach(r => {
      if (typeof r.value === 'number' && r.value > avg + 2 * stdDev) {
        signals.push(
          `OUTLIER: ${r.commodity} trade with ${r.partner} = $${(r.value / 1e9).toFixed(2)}B ` +
          `(mean: $${(avg / 1e9).toFixed(2)}B)`
        );
      }
    });
  }

  return signals;
}

// Briefing — check recent trade data for key commodities, detect anomalies
//
// Annual ("A") HS data for the *current* year does not exist mid-year, so the
// old code spent one guaranteed-empty request per pair before retrying the
// previous year. We ask for the previous year first and only reach further
// back when that year genuinely returned nothing (never when it errored).
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const deadline = Date.now() + BUDGET_MS;

  const prevYear = new Date().getFullYear() - 1;

  // Key combinations to check: US/China imports of strategic commodities
  const keyCommodities = ['2709', '2711', '7108', '8542', '93'];
  const keyReporters = [842, 156]; // US, China

  const pairs = keyReporters.flatMap(reporter =>
    keyCommodities.map(cmdCode => ({ reporter, cmdCode }))
  );

  const fetched = await mapWithConcurrency(pairs, CONCURRENCY, async ({ reporter, cmdCode }) => {
    const first = readRecords(await getTradeData({
      reporterCode: reporter,
      cmdCode,
      period: prevYear,
      flowCode: 'M',
      signal,
    }));

    // An upstream failure is terminal for this pair — retrying an older year
    // would just burn another request against the same broken endpoint.
    if (first.error) return { reporter, cmdCode, period: prevYear, error: first.error };
    if (first.records.length) return { reporter, cmdCode, period: prevYear, records: first.records };

    // Genuinely empty year: reach back one more, budget permitting.
    if (Date.now() > deadline || signal?.aborted) {
      return { reporter, cmdCode, period: prevYear, records: [] };
    }
    const second = readRecords(await getTradeData({
      reporterCode: reporter,
      cmdCode,
      period: prevYear - 1,
      flowCode: 'M',
      signal,
    }));
    if (second.error) return { reporter, cmdCode, period: prevYear - 1, error: second.error };
    return { reporter, cmdCode, period: prevYear - 1, records: second.records };
  });

  const tradeFlows = [];
  const signals = [];
  const failures = [];

  for (const entry of fetched) {
    if (!entry) continue;
    if (entry.error) {
      failures.push({
        reporter: COUNTRIES[entry.reporter] || entry.reporter,
        commodity: STRATEGIC_COMMODITIES[entry.cmdCode] || entry.cmdCode,
        error: entry.error,
      });
      continue;
    }

    const compact = entry.records.slice(0, 10).map(compactRecord);
    if (!compact.length) continue;

    tradeFlows.push({
      reporter: COUNTRIES[entry.reporter] || entry.reporter,
      commodity: STRATEGIC_COMMODITIES[entry.cmdCode] || entry.cmdCode,
      cmdCode: entry.cmdCode,
      period: entry.period,
      topPartners: compact,
      totalRecords: entry.records.length,
    });

    signals.push(...detectAnomalies(compact));
  }

  return {
    source: 'UN Comtrade',
    timestamp: new Date().toISOString(),
    period: prevYear,
    tradeFlows,
    // "No anomalies" is a finding only when the queries actually ran.
    signals: signals.length > 0
      ? signals
      : (failures.length ? [] : ['No significant trade anomalies detected in sampled commodities']),
    status: tradeFlows.length > 0 ? 'ok' : (failures.length ? 'error' : 'no_data'),
    note: 'Comtrade annual data lags; the current calendar year is never available.',
    coveredCommodities: STRATEGIC_COMMODITIES,
    coveredCountries: COUNTRIES,
    ...(failures.length ? {
      error: `Comtrade failed for ${failures.length}/${pairs.length} reporter/commodity pairs: ${failures[0].error}`,
      failures,
    } : {}),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('comtrade.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
