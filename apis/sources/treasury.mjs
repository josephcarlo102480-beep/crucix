// US Treasury Fiscal Data — Government debt, spending, yields
// No auth required. Daily updates.

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';

// Debt to the Penny (daily national debt).
// `page[size]` tracks `days` — asking for 14 days but paging 30 records used to
// pull rows from outside the requested window.
export async function getDebtToThePenny(days = 30, opts = {}) {
  const params = new URLSearchParams({
    'fields': 'record_date,tot_pub_debt_out_amt,intragov_hold_amt,debt_held_public_amt',
    'sort': '-record_date',
    'page[size]': String(Math.max(1, Math.min(Number(days) || 30, 1000))),
    'filter': `record_date:gte:${daysAgo(days)}`,
  });
  return safeFetch(`${BASE}/v2/accounting/od/debt_to_penny?${params}`, { timeout: 12000, signal: opts.signal });
}

// Daily Treasury Statement (government cash flow)
export async function getDailyStatement(days = 7, opts = {}) {
  const params = new URLSearchParams({
    'fields': 'record_date,account_type,close_today_bal',
    'sort': '-record_date',
    'page[size]': '20',
    'filter': `record_date:gte:${daysAgo(days)}`,
  });
  return safeFetch(`${BASE}/v1/accounting/dts/deposits_withdrawals_operating_cash?${params}`, { timeout: 12000, signal: opts.signal });
}

// Treasury yield curves (average interest rates on debt)
export async function getAvgInterestRates(opts = {}) {
  const params = new URLSearchParams({
    'fields': 'record_date,security_desc,avg_interest_rate_amt',
    'sort': '-record_date',
    'page[size]': '50',
    'filter': `record_date:gte:${daysAgo(30)}`,
  });
  return safeFetch(`${BASE}/v2/accounting/od/avg_interest_rates?${params}`, { timeout: 12000, signal: opts.signal });
}

// Briefing — key treasury data
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const [debt, rates] = await Promise.all([
    getDebtToThePenny(14, { signal }),
    getAvgInterestRates({ signal }),
  ]);

  const errors = [];
  const debtData = Array.isArray(debt?.data) ? debt.data : [];
  if (!Array.isArray(debt?.data)) {
    errors.push(`debt_to_penny: ${debt?.error || 'response had no data array'}`);
  }
  const rateData = Array.isArray(rates?.data) ? rates.data : [];
  if (!Array.isArray(rates?.data)) {
    errors.push(`avg_interest_rates: ${rates?.error || 'response had no data array'}`);
  }

  const latestDebt = debtData[0];
  const signals = [];

  if (latestDebt) {
    const totalDebt = parseFloat(latestDebt.tot_pub_debt_out_amt);
    if (totalDebt > 36_000_000_000_000) {
      signals.push(`National debt at $${(totalDebt / 1e12).toFixed(2)}T`);
    }
  }

  return {
    source: 'US Treasury',
    timestamp: new Date().toISOString(),
    debt: debtData.slice(0, 5).map(d => ({
      date: d.record_date,
      totalDebt: d.tot_pub_debt_out_amt,
      publicDebt: d.debt_held_public_amt,
      intragovDebt: d.intragov_hold_amt,
    })),
    interestRates: rateData.slice(0, 20).map(r => ({
      date: r.record_date,
      security: r.security_desc,
      rate: r.avg_interest_rate_amt,
    })),
    signals,
    ...(errors.length ? { error: `US Treasury fiscal data unavailable — ${errors.join('; ')}` } : {}),
  };
}

if (process.argv[1]?.endsWith('treasury.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
