// OFAC — US Treasury Office of Foreign Assets Control Sanctions
// No auth required. Monitors the Specially Designated Nationals (SDN) list.
//
// Reuses the SDN cache maintained by services/sanctions/ofacSanctions.mjs
// (OpenSanctions us_ofac_sdn CSV, ~7 MB, 24h TTL, single-flight). The old
// implementation re-downloaded the full SDN XML exports (hundreds of MB)
// every sweep and timed out; this one reads the parsed in-memory list.

import { warmCache, cacheSnapshot } from '../../services/sanctions/ofacSanctions.mjs';

// Briefing — report sanctions list status, size, and newest designations
export async function briefing() {
  await warmCache(); // no-op when fresh; single-flight download otherwise

  const snap = cacheSnapshot(10);
  if (!snap) throw new Error('SDN list unavailable (download failed and no cached copy)');

  return {
    source: 'OFAC Sanctions',
    timestamp: new Date().toISOString(),
    lastUpdated: snap.fetchedAt,
    sdnList: {
      entryCount: snap.entryCount,
      dataAvailable: snap.entryCount > 0,
    },
    // Newest designations by first_seen — fresh additions to the SDN list
    sampleEntries: snap.recent,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('ofac.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
