#!/usr/bin/env node

// Crucix Master Orchestrator — runs all intelligence sources in parallel
// Outputs structured JSON for Claude to synthesize into actionable briefing

import './utils/env.mjs'; // Load API keys from .env
import { pathToFileURL } from 'node:url';
import { sourceState, buildSourceHealth, sourceCounts } from '../lib/source-health.mjs';

// === Tier 1: Core OSINT & Geopolitical ===
import { briefing as gdelt } from './sources/gdelt.mjs';
import { briefing as opensky } from './sources/opensky.mjs';
import { briefing as firms } from './sources/firms.mjs';
import { briefing as ships } from './sources/ships.mjs';
import { briefing as safecast } from './sources/safecast.mjs';
import { sweepBriefing as radiationEu } from './sources/radiation-eu.mjs';
import { briefing as acled } from './sources/acled.mjs';
import { briefing as reliefweb } from './sources/reliefweb.mjs';
import { briefing as who } from './sources/who.mjs';

// === Tier 2: Economic & Financial ===
import { briefing as fred } from './sources/fred.mjs';
import { briefing as treasury } from './sources/treasury.mjs';
import { briefing as bls } from './sources/bls.mjs';
import { briefing as eia } from './sources/eia.mjs';
import { briefing as gscpi } from './sources/gscpi.mjs';
import { briefing as usaspending } from './sources/usaspending.mjs';
import { briefing as comtrade } from './sources/comtrade.mjs';

// === Tier 3: Weather, Environment, Technology, Social ===
import { briefing as noaa } from './sources/noaa.mjs';
import { briefing as epa } from './sources/epa.mjs';
import { briefing as patents } from './sources/patents.mjs';
import { briefing as bluesky } from './sources/bluesky.mjs';
import { briefing as reddit } from './sources/reddit.mjs';
import { briefing as kiwisdr } from './sources/kiwisdr.mjs';

// === Tier 4: Space & Satellites ===
import { briefing as space } from './sources/space.mjs';

// === Tier 5: Live Market Data ===
import { briefing as yfinance } from './sources/yfinance.mjs';

// === Tier 6: Cyber & Infrastructure ===
import { briefing as cisaKev } from './sources/cisa-kev.mjs';
import { briefing as cloudflareRadar } from './sources/cloudflare-radar.mjs';

const SOURCE_TIMEOUT_MS = 30_000; // 30s max per individual source
const SOURCE_TIMEOUT_OVERRIDES = {
  OpenSky: 90_000, // OpenSky queries hotspots sequentially with delays to avoid 429s
  Comtrade: 75_000, // Ten paced trade queries plus bounded retries
};

export async function runSource(name, fn, ...args) {
  const start = Date.now();
  let timer;
  const timeoutMs = SOURCE_TIMEOUT_OVERRIDES[name] || SOURCE_TIMEOUT_MS;
  // Sources may accept a trailing `{ signal }` and abandon in-flight fetches
  // when the source-level timeout fires; ones that ignore it just get an
  // unused extra argument.
  const controller = new AbortController();
  try {
    const dataPromise = fn(...args, { signal: controller.signal });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Source ${name} timed out`));
        reject(new Error(`Source ${name} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });
    const data = await Promise.race([dataPromise, timeoutPromise]);
    const status = sourceState(data);
    return { name, status, durationMs: Date.now() - start, data: data && typeof data === 'object' ? { ...data, status } : null };
  } catch (e) {
    return { name, status: 'failed', durationMs: Date.now() - start, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function fullBriefing(previousHealth = []) {
  console.error('[Crucix] Starting intelligence sweep — 26 sources...');
  const start = Date.now();

  const allPromises = [
    // Tier 1: Core OSINT & Geopolitical
    runSource('GDELT', gdelt),
    runSource('OpenSky', opensky),
    runSource('FIRMS', firms),
    runSource('Maritime', ships),
    runSource('Safecast', safecast),
    runSource('Radiation-EU', radiationEu),
    runSource('ACLED', acled),
    runSource('ReliefWeb', reliefweb),
    runSource('WHO', who),

    // Tier 2: Economic & Financial
    runSource('FRED', fred, process.env.FRED_API_KEY),
    runSource('Treasury', treasury),
    runSource('BLS', bls, process.env.BLS_API_KEY),
    runSource('EIA', eia, process.env.EIA_API_KEY),
    runSource('GSCPI', gscpi),
    runSource('USAspending', usaspending),
    runSource('Comtrade', comtrade),

    // Tier 3: Weather, Environment, Technology, Social
    runSource('NOAA', noaa),
    runSource('EPA', epa),
    runSource('Patents', patents),
    runSource('Bluesky', bluesky),
    runSource('Reddit', reddit),
    runSource('KiwiSDR', kiwisdr),

    // Tier 4: Space & Satellites
    runSource('Space', space),

    // Tier 5: Live Market Data
    runSource('YFinance', yfinance),

    // Tier 6: Cyber & Infrastructure
    runSource('CISA-KEV', cisaKev),
    runSource('Cloudflare-Radar', cloudflareRadar),
  ];

  // Each runSource has its own 30s timeout, so allSettled will resolve
  // within ~30s even if APIs hang. Global timeout is a safety net.
  const results = await Promise.allSettled(allPromises);

  const sources = results.map(r => r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message });
  const totalMs = Date.now() - start;

  const returnedData = Object.fromEntries(sources.filter(s => s.data).map(s => [s.name, s.data]));
  const errors = sources.filter(s => !s.data).map(s => ({ name: s.name, error: s.error || 'Source returned no data' }));
  const timestamp = new Date().toISOString();
  const sourceHealth = buildSourceHealth(returnedData, errors, previousHealth, timestamp);

  const output = {
    crucix: {
      version: '2.0.0',
      timestamp,
      totalDurationMs: totalMs,
      ...sourceCounts(sourceHealth),
    },
    // Degraded sources keep their payload: it carries `.error` plus whatever
    // partial/stale data the source salvaged, which the dashboard renders.
    sources: returnedData,
    sourceHealth,
    errors,
    timing: Object.fromEntries(
      sources.map(s => [s.name, { status: s.status, ms: s.durationMs }])
    ),
  };

  console.error(`[Crucix] Sweep complete in ${totalMs}ms — ${output.crucix.sourcesOk}/${sources.length} sources returned data`);
  return output;
}

// Run and output when executed directly
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref && import.meta.url === entryHref) {
  const data = await fullBriefing();
  console.log(JSON.stringify(data, null, 2));
}
