// GSCPI — NY Fed Global Supply Chain Pressure Index
// Measures global supply chain stress (standard deviations from historical average).
// Values above 0 = above average pressure. Above 1.0 = elevated. Below -1.0 = unusually loose.
// Data fetched directly from NY Fed — no API key required.

import { safeFetch } from '../utils/fetch.mjs';

const GSCPI_CSV_URL = 'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv';

// Fetch and parse the GSCPI CSV from the NY Fed.
// The CSV is wide-format: each column is a revision vintage, last column is the
// latest estimate. `responseType: 'text'` keeps the full body (the default JSON
// mode would truncate a non-JSON payload to 500 chars).
export async function getGSCPI(months = 12, opts = {}) {
  const res = await safeFetch(GSCPI_CSV_URL, {
    timeout: 20000,
    responseType: 'text',
    signal: opts.signal,
  });
  if (res?.error) return { error: res.error, data: [] };

  const rows = parseCSV(String(res?.text || ''), months);
  // An unparseable CSV (redirect page, HTML error, changed layout) is a failure,
  // not a supply chain with no history.
  if (!rows.length) return { error: 'GSCPI CSV contained no parseable rows', data: [] };
  return { data: rows };
}

// Parse the wide-format CSV, extracting the latest vintage value for each date
function parseCSV(text, months) {
  const lines = text.trim().split('\n').filter(l => l.trim() && !l.startsWith(','));
  if (lines.length < 2) return [];

  // Header row tells us column count; we want the last non-empty column for each row
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[0]?.trim();
    if (!dateStr) continue;

    // Find the last non-empty, non-#N/A value (latest vintage estimate)
    let value = null;
    for (let j = cols.length - 1; j >= 1; j--) {
      const v = cols[j]?.trim();
      if (v && v !== '#N/A' && v !== '') {
        const num = parseFloat(v);
        if (!isNaN(num)) {
          value = num;
          break;
        }
      }
    }

    if (value === null) continue;

    // Parse date from "31-Jan-2026" format to "2026-01"
    const date = parseNYFedDate(dateStr);
    if (date) {
      results.push({ date, value });
    }
  }

  // Sort newest first
  results.sort((a, b) => b.date.localeCompare(a.date));

  return results.slice(0, months);
}

// Parse "31-Jan-2026" -> "2026-01"
function parseNYFedDate(str) {
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const parts = str.split('-');
  if (parts.length !== 3) return null;
  const mon = months[parts[1]];
  const year = parts[2];
  if (!mon || !year) return null;
  return `${year}-${mon}`;
}

// Detect trend from an array of {date, value} sorted newest-first
function detectTrend(history) {
  if (history.length < 3) return 'insufficient data';

  // Compare recent 3 months direction
  const recent = history.slice(0, 3);
  let rising = 0;
  let falling = 0;

  for (let i = 0; i < recent.length - 1; i++) {
    // history is newest-first, so recent[0] is latest
    if (recent[i].value > recent[i + 1].value) rising++;
    else if (recent[i].value < recent[i + 1].value) falling++;
  }

  if (rising > falling) return 'rising';
  if (falling > rising) return 'falling';
  return 'stable';
}

// Briefing — latest GSCPI, trend, and signals
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const result = await getGSCPI(12, { signal });

  if (result.error) {
    return {
      source: 'NY Fed GSCPI',
      error: result.error,
      timestamp: new Date().toISOString(),
      latest: null,
      trend: 'unknown',
      history: [],
      signals: [],
    };
  }

  const history = result.data;
  const trend = detectTrend(history);
  const signals = [];

  const latest = history.length > 0 ? history[0] : null;

  if (latest) {
    if (latest.value > 2.0) {
      signals.push(`GSCPI extremely elevated at ${latest.value.toFixed(2)} — severe supply chain stress`);
    } else if (latest.value > 1.0) {
      signals.push(`GSCPI elevated at ${latest.value.toFixed(2)} — above-normal supply chain pressure`);
    } else if (latest.value < -1.0) {
      signals.push(`GSCPI at ${latest.value.toFixed(2)} — unusually loose supply chains`);
    }

    if (trend === 'rising' && latest.value > 0) {
      signals.push('Supply chain pressure trending higher');
    }
    if (trend === 'falling' && latest.value > 1.0) {
      signals.push('Supply chain pressure elevated but improving');
    }
  }

  // Check month-over-month change
  if (history.length >= 2) {
    const mom = history[0].value - history[1].value;
    if (Math.abs(mom) > 0.5) {
      const dir = mom > 0 ? 'surged' : 'dropped';
      signals.push(`GSCPI ${dir} ${Math.abs(mom).toFixed(2)} points month-over-month`);
    }
  }

  return {
    source: 'NY Fed GSCPI',
    timestamp: new Date().toISOString(),
    latest: latest ? {
      value: latest.value,
      date: latest.date,
      interpretation: latest.value > 1.0 ? 'elevated' :
                      latest.value > 0 ? 'above average' :
                      latest.value > -1.0 ? 'below average' : 'unusually loose',
    } : null,
    trend,
    history,
    signals,
  };
}

if (process.argv[1]?.endsWith('gscpi.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
