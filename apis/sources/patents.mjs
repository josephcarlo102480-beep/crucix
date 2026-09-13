// USPTO PatentsView — Patent Intelligence
// Tracks patent filings in strategic technology areas.
// Useful for detecting R&D trends, tech competition, state-backed innovation.
//
// UPSTREAM STATUS (verified 2026-09-02): the PatentsView API has been retired.
// search.patentsview.org no longer resolves (NXDOMAIN) and api.patentsview.org
// redirects to https://data.uspto.gov/support/transition-guide/patentsview.
// The replacement is the USPTO Open Data Portal, which requires a (free)
// API key. Until this source is migrated it reports `error` every sweep —
// which is correct: it must not look like "no patent activity".

const TRANSITION_URL = 'https://data.uspto.gov/support/transition-guide/patentsview';
const UNAVAILABLE = 'The legacy PatentsView search API is unavailable following the USPTO Open Data Portal migration. This connector needs a supported replacement; installing packages or retrying cannot restore it.';

// Strategic technology domains and their search terms
const STRATEGIC_DOMAINS = {
  ai: {
    label: 'Artificial Intelligence',
    terms: ['artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'large language model'],
  },
  quantum: {
    label: 'Quantum Computing',
    terms: ['quantum computing', 'quantum processor', 'qubit', 'quantum entanglement', 'quantum cryptography'],
  },
  nuclear: {
    label: 'Nuclear Technology',
    terms: ['nuclear fusion', 'nuclear reactor', 'nuclear fuel', 'uranium enrichment', 'small modular reactor'],
  },
  hypersonic: {
    label: 'Hypersonic & Advanced Propulsion',
    terms: ['hypersonic', 'scramjet', 'directed energy weapon', 'railgun', 'advanced propulsion'],
  },
  semiconductor: {
    label: 'Semiconductor & Chip Technology',
    terms: ['semiconductor', 'integrated circuit', 'lithography', 'chip fabrication', 'transistor'],
  },
  biotech: {
    label: 'Biotechnology & Synthetic Biology',
    terms: ['synthetic biology', 'gene editing', 'CRISPR', 'mRNA', 'bioweapon'],
  },
  space: {
    label: 'Space & Satellite Technology',
    terms: ['satellite', 'space launch', 'orbital', 'space debris', 'anti-satellite'],
  },
};

// Keep the public helpers callable without querying a decommissioned host.
export async function searchPatents() {
  return { error: UNAVAILABLE, source: TRANSITION_URL };
}

export async function searchByAssignee() {
  return searchPatents();
}

export async function briefing() {
  return {
    source: 'USPTO Patents',
    timestamp: new Date().toISOString(),
    status: 'failed',
    error: UNAVAILABLE,
    transitionUrl: TRANSITION_URL,
    totalFound: null,
    recentPatents: Object.fromEntries(Object.keys(STRATEGIC_DOMAINS).map(key => [key, []])),
    domains: Object.fromEntries(Object.entries(STRATEGIC_DOMAINS).map(([key, domain]) => [key, domain.label])),
    signals: [],
  };
}

if (process.argv[1]?.endsWith('patents.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}
