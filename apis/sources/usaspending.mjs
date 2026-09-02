// USAspending — Federal spending, defense contracts, procurement signals
// No auth required. Updated daily.

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const BASE = 'https://api.usaspending.gov/api/v2';

// Award type codes — required by the spending_by_award endpoint
// Contracts: A=BPA Call, B=Purchase Order, C=Delivery Order, D=Definitive Contract
// Grants: 02=Block Grant, 03=Formula Grant, 04=Project Grant, 05=Cooperative Agreement
// Direct payments: 06=Direct Payment (unrestricted), 07=Direct Payment (specified use)
// Loans: 08=Direct Loan, 09=Guaranteed/Insured Loan
// IDVs: IDV_A=GWAC, IDV_B=IDC, IDV_B_A=IDC / IDV, IDV_B_B=IDC / Multiple Award,
//        IDV_B_C=IDC / FSS, IDV_C=FSS, IDV_D=BOA, IDV_E=BPA
const CONTRACT_CODES = ['A', 'B', 'C', 'D'];
const ALL_AWARD_CODES = ['A', 'B', 'C', 'D', '02', '03', '04', '05', '06', '07', '08', '09'];

// Search recent awards/contracts
export async function searchAwards(opts = {}) {
  const {
    keywords = ['defense', 'military'],
    limit = 20,
    sortField = 'Award Amount',
    order = 'desc',
    awardTypeCodes = CONTRACT_CODES,
    days = 30,
    signal,
  } = opts;

  const body = {
    filters: {
      keywords,
      time_period: [{ start_date: daysAgo(days), end_date: daysAgo(0) }],
      award_type_codes: awardTypeCodes,
    },
    fields: [
      'Award ID',
      'Recipient Name',
      'Award Amount',
      'Description',
      'Awarding Agency',
      'Start Date',
      'Award Type',
    ],
    limit,
    page: 1,
    sort: sortField,
    order,
  };

  // safeFetch owns the timeout/abort/retry plumbing and never rejects. The old
  // hand-rolled version returned `res.json()` un-awaited inside the try, so a
  // malformed body rejected past the catch and took the whole source down.
  const data = await safeFetch(`${BASE}/search/spending_by_award/`, {
    method: 'POST',
    body,
    timeout: 15000,
    signal,
  });

  if (!data || data.error) return { error: data?.error || 'no response from USAspending', results: [] };
  if (data.rawText !== undefined) {
    return { error: `USAspending returned a non-JSON body: ${String(data.rawText).slice(0, 200)}`, results: [] };
  }
  if (!Array.isArray(data.results)) {
    return { error: 'USAspending response had no results array', results: [] };
  }
  return data;
}

// Get top agencies by spending
export async function getAgencySpending(opts = {}) {
  return safeFetch(`${BASE}/references/toptier_agencies/`, { timeout: 15000, signal: opts.signal });
}

// Search for defense-specific spending
export async function getDefenseSpending(days = 30, opts = {}) {
  return searchAwards({
    keywords: ['defense', 'military', 'missile', 'ammunition', 'aircraft', 'naval'],
    limit: 20,
    sortField: 'Award Amount',
    order: 'desc',
    awardTypeCodes: CONTRACT_CODES,
    days,
    signal: opts.signal,
  });
}

// Briefing
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const [defense, agencies] = await Promise.all([
    getDefenseSpending(14, { signal }),
    getAgencySpending({ signal }),
  ]);

  const errors = [];
  if (defense?.error) errors.push(`defense contracts: ${defense.error}`);
  const agencyResults = Array.isArray(agencies?.results) ? agencies.results : [];
  if (!Array.isArray(agencies?.results)) {
    errors.push(`agency spending: ${agencies?.error || 'response had no results array'}`);
  }

  return {
    source: 'USAspending',
    timestamp: new Date().toISOString(),
    recentDefenseContracts: (Array.isArray(defense?.results) ? defense.results : []).slice(0, 10).map(r => ({
      awardId: r['Award ID'],
      recipient: r['Recipient Name'],
      amount: r['Award Amount'],
      description: r['Description'],
      agency: r['Awarding Agency'],
      date: r['Start Date'],
      type: r['Award Type'],
    })),
    topAgencies: agencyResults.slice(0, 10).map(a => ({
      name: a.agency_name,
      budget: a.budget_authority_amount,
      obligations: a.obligated_amount,
      outlays: a.outlay_amount,
    })),
    ...(defense?.error ? { defenseError: defense.error } : {}),
    ...(errors.length ? { error: `USAspending partial failure — ${errors.join('; ')}` } : {}),
  };
}

if (process.argv[1]?.endsWith('usaspending.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
