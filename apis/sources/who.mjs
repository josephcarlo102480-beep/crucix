// WHO — World Health Organization Global Health Observatory
// No auth required. Disease outbreak monitoring.

import { safeFetch } from '../utils/fetch.mjs';

const GHO_BASE = 'https://ghoapi.azureedge.net/api';
const DON_API = 'https://www.who.int/api/news/diseaseoutbreaknews';

// Get GHO indicator data
export async function getIndicator(code, opts = {}) {
  const { filter = '', top = 20, signal } = opts;
  let url = `${GHO_BASE}/${code}?$top=${top}&$orderby=TimeDim desc`;
  if (filter) url += `&$filter=${filter}`;
  return safeFetch(url, { timeout: 15000, signal });
}

// Key health indicators
const INDICATORS = {
  MDG_0000000020: 'TB incidence (per 100k)',
  MALARIA_EST_CASES: 'Malaria estimated cases',
  WHOSIS_000001: 'Life expectancy at birth',
  UHC_INDEX_REPORTED: 'UHC Service Coverage Index',
};

// Get Disease Outbreak News via WHO JSON API
// The old RSS feed at /feeds/entity/don/en/rss.xml returns 404.
// Without an explicit order the endpoint returns its 50 oldest items
// (2004 onwards), so every recent notice fell outside the 30-day window.
// It honours $orderby on PublicationDateAndTime; we still sort client-side
// in case that ever changes.
const DON_QUERY = '?$orderby=PublicationDateAndTime%20desc&$top=50';
const ARCHIVE_ONLY_MS = 365 * 24 * 60 * 60 * 1000;

export async function getOutbreakNews(opts = {}) {
  const data = await safeFetch(DON_API + DON_QUERY, { timeout: 15000, signal: opts.signal });

  if (!data || data.error) return { error: data?.error || 'no response from WHO DON API' };
  if (data.rawText !== undefined) {
    return { error: `WHO DON API returned a non-JSON body: ${String(data.rawText).slice(0, 120)}` };
  }
  if (!Array.isArray(data.value)) return { error: 'WHO DON response had no value array' };

  const items = [...data.value];

  items.sort((a, b) => {
    const da = new Date(a.PublicationDate || 0);
    const db = new Date(b.PublicationDate || 0);
    return db - da;
  });

  // WHO publishes several notices a month. If even the newest item is a year
  // old, the query is being served from the archive again, and an empty list
  // would read as "no outbreaks".
  const newest = new Date(items[0]?.PublicationDate || 0).getTime();
  if (items.length && Date.now() - newest > ARCHIVE_ONLY_MS) {
    return { error: `WHO DON API returned only archive items (newest ${items[0].PublicationDate})` };
  }

  // Filter to last 30 days only
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = items.filter(item => new Date(item.PublicationDate || 0) >= cutoff);

  return recent.map(item => ({
    title: item.Title,
    date: item.PublicationDate,
    donId: item.DonId || null,
    url: item.ItemDefaultUrl
      ? `https://www.who.int/emergencies/disease-outbreak-news${item.ItemDefaultUrl}`
      : null,
    summary: (item.Summary || item.Overview || '').replace(/<[^>]*>/g, '').slice(0, 300) || null,
  }));
}

// Briefing
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const outbreaks = await getOutbreakNews({ signal });
  const ok = Array.isArray(outbreaks);

  return {
    source: 'WHO',
    timestamp: new Date().toISOString(),
    diseaseOutbreakNews: ok ? outbreaks.slice(0, 15) : [],
    outbreakError: ok ? null : outbreaks.error,
    // An empty outbreak list from a failed fetch is not "no outbreaks".
    ...(ok ? {} : { error: `WHO Disease Outbreak News unavailable: ${outbreaks.error}` }),
    monitoringCapabilities: [
      'Disease Outbreak News (DONs)',
      'Global health indicators (GHO)',
      'Pandemic early warning signals',
      'Cross-reference with GDELT health event mentions',
    ],
  };
}

if (process.argv[1]?.endsWith('who.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
