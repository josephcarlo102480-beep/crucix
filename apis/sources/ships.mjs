// Ship/Vessel Tracking — aisstream.io (free real-time global AIS)
// Also includes fallback to public vessel tracking data
// Detects: dark ships, sanctions evasion, naval deployments, port congestion

import '../utils/env.mjs';

// aisstream.io requires a WebSocket connection for real-time data
// For briefing mode, we'll use snapshot-based approaches

// MarineTraffic-style density estimation via public endpoints
// The real power comes from running a persistent WebSocket listener

// Key maritime chokepoints to monitor
const CHOKEPOINTS = {
  straitOfHormuz: { label: 'Strait of Hormuz', lat: 26.5, lon: 56.5, note: '20% of world oil' },
  suezCanal: { label: 'Suez Canal', lat: 30.5, lon: 32.3, note: '12% of world trade' },
  straitOfGibraltar: { label: 'Strait of Gibraltar', lat: 36.0, lon: -5.7, note: 'Gateway to Mediterranean, ~10-20% global trade influence' },
  straitOfMalacca: { label: 'Strait of Malacca', lat: 2.5, lon: 101.5, note: '25% of world trade' },
  babElMandeb: { label: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, note: 'Red Sea gateway' },
  taiwanStrait: { label: 'Taiwan Strait', lat: 24.0, lon: 119.0, note: '88% of largest container ships' },
  bosporusStrait: { label: 'Bosphorus', lat: 41.1, lon: 29.1, note: 'Black Sea access' },
  panamaCanal: { label: 'Panama Canal', lat: 9.1, lon: -79.7, note: '5% of world trade' },
  capeOfGoodHope: { label: 'Cape of Good Hope', lat: -34.4, lon: 18.5, note: 'Suez alternative' },
};

// Briefing mode has no live AIS: aisstream.io is WebSocket-only, so this
// returns the static chokepoint reference set plus an honest statement of what
// is (not) being observed. Without a key there is no vessel tracking at all,
// and that is reported as an error so the sweep marks the source degraded
// instead of counting an empty maritime picture as a success.
export async function briefing() {
  const hasKey = !!process.env.AISSTREAM_API_KEY;

  return {
    source: 'Maritime/AIS',
    timestamp: new Date().toISOString(),
    status: hasKey ? 'degraded' : 'unconfigured',
    message: hasKey
      ? 'AIS stream credentials present — run the WebSocket listener for real-time vessel data'
      : 'Live vessel tracking requires AISSTREAM_API_KEY and an AIS WebSocket collector; this connector currently provides static reference locations only',
    error: 'No vessel positions collected; chokepoints below are static reference geometry only',
    chokepoints: CHOKEPOINTS,
    monitoringCapabilities: [
      'Dark ship detection (AIS transponder shutoffs)',
      'Sanctions evasion (ship-to-ship transfers)',
      'Naval deployment tracking',
      'Port congestion (vessel dwell time)',
      'Chokepoint traffic anomalies',
      'Oil tanker route changes',
    ],
    hint: 'For now, I can use web search to check maritime news and shipping disruptions',
  };
}

// WebSocket listener setup (for persistent monitoring)
export function getWebSocketConfig(apiKey) {
  return {
    url: 'wss://stream.aisstream.io/v0/stream',
    message: JSON.stringify({
      APIKey: apiKey,
      BoundingBoxes: Object.values(CHOKEPOINTS).map(cp => [
        [cp.lat - 2, cp.lon - 2],
        [cp.lat + 2, cp.lon + 2],
      ]),
    }),
  };
}

if (process.argv[1]?.endsWith('ships.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
