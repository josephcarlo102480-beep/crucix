// CISA KEV — Known Exploited Vulnerabilities Catalog
// No auth required. Tracks CVEs actively exploited in the wild.
// Federal agencies must patch these within due dates — useful signal
// for cybersecurity posture and active threat landscape.

import { safeFetch } from '../utils/fetch.mjs';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

function summarizeVulnerabilities(vulns) {
  if (!vulns.length) return {};

  // Recent additions (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
  const recent = vulns.filter(v => {
    const added = new Date(v.dateAdded);
    return !isNaN(added) && added >= thirtyDaysAgo;
  });

  // Group by vendor
  const byVendor = {};
  for (const v of vulns) {
    const vendor = v.vendorProject || 'Unknown';
    byVendor[vendor] = (byVendor[vendor] || 0) + 1;
  }

  // Top vendors sorted by count
  const topVendors = Object.entries(byVendor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([vendor, count]) => ({ vendor, count }));

  // Ransomware-linked
  const ransomwareLinked = vulns.filter(v => v.knownRansomwareCampaignUse === 'Known');

  // Overdue, scoped to the recent-additions window. Across the whole catalog
  // "overdue" is a monotonically growing count of every CVE ever listed whose
  // remediation date has passed — it is ~the catalog size and says nothing
  // about the current week. Only overdue items among recent additions are news.
  const now = new Date();
  const overdue = recent.filter(v => {
    const due = new Date(v.dueDate);
    return !isNaN(due) && due < now;
  });

  // Group recent by product for signal detection
  const recentByProduct = {};
  for (const v of recent) {
    const key = `${v.vendorProject} ${v.product}`;
    if (!recentByProduct[key]) recentByProduct[key] = [];
    recentByProduct[key].push(v);
  }

  const hotProducts = Object.entries(recentByProduct)
    .filter(([, vs]) => vs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([product, vs]) => ({
      product,
      count: vs.length,
      cves: vs.map(v => v.cveID)
    }));

  // Baseline: how many entries CISA adds in a typical 30-day window, measured
  // over the catalog's own history. Used to decide whether "N new entries" is
  // actually elevated instead of just "it is Tuesday".
  const addedTimes = vulns
    .map(v => new Date(v.dateAdded).getTime())
    .filter(t => Number.isFinite(t));
  const earliest = addedTimes.length ? Math.min(...addedTimes) : null;
  const spanDays = earliest ? Math.max((Date.now() - earliest) / 86400_000, 30) : null;
  const baselineAdditions30d = spanDays ? (vulns.length / spanDays) * 30 : null;

  return {
    totalInCatalog: vulns.length,
    recentAdditions: recent.length,
    recentOverdue: overdue.length,
    ransomwareLinked: ransomwareLinked.length,
    overdueCount: overdue.length,
    baselineAdditions30d: baselineAdditions30d === null ? null : +baselineAdditions30d.toFixed(1),
    topVendors,
    hotProducts,
  };
}

export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const data = await safeFetch(KEV_URL, { timeout: 20000, signal });

  if (!data || data.error || !Array.isArray(data.vulnerabilities)) {
    return {
      source: 'CISA-KEV',
      timestamp: new Date().toISOString(),
      error: data?.error || 'CISA KEV feed returned no vulnerabilities array',
      summary: {},
      vulnerabilities: [],
      signals: [],
    };
  }

  const vulns = data.vulnerabilities;
  const catalogVersion = data.catalogVersion || null;
  const dateReleased = data.dateReleased || null;

  const summary = summarizeVulnerabilities(vulns);

  // Get the 20 most recently added
  const sorted = [...vulns]
    .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));

  const recentEntries = sorted.slice(0, 20).map(v => ({
    cveID: v.cveID,
    vendorProject: v.vendorProject,
    product: v.product,
    vulnerabilityName: v.vulnerabilityName,
    dateAdded: v.dateAdded,
    dueDate: v.dueDate,
    shortDescription: (v.shortDescription || '').substring(0, 300),
    knownRansomwareCampaignUse: v.knownRansomwareCampaignUse,
  }));

  // Signals — actionable intelligence
  const signals = [];

  // Fire only when the last 30 days genuinely outrun the catalog's own long-run
  // rate (1.75x, and at least 8 entries). The old `> 5` threshold was below the
  // ordinary cadence, so this signal fired on literally every sweep and carried
  // no information.
  const baseline = summary.baselineAdditions30d;
  const elevated = baseline !== null
    ? summary.recentAdditions >= 8 && summary.recentAdditions > baseline * 1.75
    : summary.recentAdditions >= 20;
  if (elevated) {
    signals.push({
      severity: 'high',
      signal: `${summary.recentAdditions} new KEV entries in last 30 days`
        + (baseline !== null ? ` vs a ${baseline}/30d baseline` : '')
        + ' — elevated exploit activity',
    });
  }

  if (summary.hotProducts?.length > 0) {
    const top = summary.hotProducts[0];
    signals.push({
      severity: 'medium',
      signal: `${top.product} has ${top.count} actively exploited CVEs recently added`,
    });
  }

  const ransomwareRecent = recentEntries.filter(v => v.knownRansomwareCampaignUse === 'Known');
  if (ransomwareRecent.length > 0) {
    signals.push({
      severity: 'critical',
      signal: `${ransomwareRecent.length} recently added CVEs linked to ransomware campaigns`,
    });
  }

  return {
    source: 'CISA-KEV',
    timestamp: new Date().toISOString(),
    catalogVersion,
    dateReleased,
    summary,
    vulnerabilities: recentEntries,
    signals,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('cisa-kev.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
