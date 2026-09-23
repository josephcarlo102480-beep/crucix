#!/usr/bin/env node
// Crucix Dashboard Data Synthesizer
// Reads runs/latest.json, fetches RSS news, generates signal-based ideas,
// and injects everything into dashboard/public/jarvis.html
//
// Exports synthesize(), generateIdeas(), fetchAllNews() for use by server.mjs

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import * as satellite from 'satellite.js';
import config from '../crucix.config.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';
import { generateLLMIdeas } from '../lib/llm/ideas.mjs';
import { buildSourceHealth, sourceCounts, sourceState } from '../lib/source-health.mjs';
import { radiationState } from '../lib/radiation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// === Helpers ===
const cyrillic = /[\u0400-\u04FF]/;
function isEnglish(text) {
  if (!text) return false;
  return !cyrillic.test(text.substring(0, 80));
}

// === Geo-tagging keyword map ===
const geoKeywords = {
  'Ukraine':[49,32],'Russia':[56,38],'Moscow':[55.7,37.6],'Kyiv':[50.4,30.5],
  'China':[35,105],'Beijing':[39.9,116.4],'Iran':[32,53],'Tehran':[35.7,51.4],
  'Israel':[31.5,35],'Gaza':[31.4,34.4],'Palestine':[31.9,35.2],
  'Syria':[35,38],'Iraq':[33,44],'Saudi':[24,45],'Yemen':[15,48],'Lebanon':[34,36],
  'India':[20,78],'Japan':[36,138],'Korea':[37,127],'Pyongyang':[39,125.7],
  'Taiwan':[23.5,121],'Philippines':[13,122],'Myanmar':[20,96],
  'Canada':[56,-96],'Mexico':[23,-102],'Brazil':[-14,-51],'Argentina':[-38,-63],
  'Colombia':[4,-74],'Venezuela':[7,-66],'Cuba':[22,-80],'Chile':[-35,-71],
  'Germany':[51,10],'France':[46,2],'UK':[54,-2],'Britain':[54,-2],'London':[51.5,-0.1],
  'Spain':[40,-4],'Italy':[42,12],'Poland':[52,20],'NATO':[50,4],'EU':[50,4],
  'Turkey':[39,35],'Greece':[39,22],'Romania':[46,25],'Finland':[64,26],'Sweden':[62,15],
  'Africa':[0,20],'Nigeria':[10,8],'South Africa':[-30,25],'Kenya':[-1,38],
  'Egypt':[27,30],'Libya':[27,17],'Sudan':[13,30],'Ethiopia':[9,38],
  'Somalia':[5,46],'Congo':[-4,22],'Uganda':[1,32],'Morocco':[32,-6],
  'Pakistan':[30,70],'Afghanistan':[33,65],'Bangladesh':[24,90],
  'Australia':[-25,134],'Indonesia':[-2,118],'Thailand':[15,100],
  'US':[39,-98],'America':[39,-98],'Washington':[38.9,-77],'Pentagon':[38.9,-77],
  'Trump':[38.9,-77],'White House':[38.9,-77],
  'Wall Street':[40.7,-74],'New York':[40.7,-74],'California':[37,-120],
  'Nepal':[28,84],'Cambodia':[12.5,105],'Malawi':[-13.5,34],'Burundi':[-3.4,29.9],
  'Oman':[21,57],'Netherlands':[52.1,5.3],'Gabon':[-0.8,11.6],
  'Peru':[-10,-76],'Ecuador':[-2,-78],'Bolivia':[-17,-65],
  'Singapore':[1.35,103.8],'Malaysia':[4.2,101.9],'Vietnam':[16,108],
  'Algeria':[28,3],'Tunisia':[34,9],'Zimbabwe':[-20,30],'Mozambique':[-18,35],
  // Americas expansion
  'Texas':[31,-100],'Florida':[28,-82],'Chicago':[41.9,-87.6],'Los Angeles':[34,-118],
  'San Francisco':[37.8,-122.4],'Seattle':[47.6,-122.3],'Miami':[25.8,-80.2],
  'Toronto':[43.7,-79.4],'Ottawa':[45.4,-75.7],'Vancouver':[49.3,-123.1],
  'São Paulo':[-23.5,-46.6],'Rio':[-22.9,-43.2],'Buenos Aires':[-34.6,-58.4],
  'Bogotá':[4.7,-74.1],'Lima':[-12,-77],'Santiago':[-33.4,-70.7],
  'Caracas':[10.5,-66.9],'Havana':[23.1,-82.4],'Panama':[9,-79.5],
  'Guatemala':[14.6,-90.5],'Honduras':[14.1,-87.2],'El Salvador':[13.7,-89.2],
  'Costa Rica':[10,-84],'Jamaica':[18.1,-77.3],'Haiti':[19,-72],
  'Dominican':[18.5,-70],'Puerto Rico':[18.2,-66.5],
  // More Asia-Pacific
  'Sri Lanka':[7,80],'Hong Kong':[22.3,114.2],'Taipei':[25,121.5],
  'Seoul':[37.6,127],'Osaka':[34.7,135.5],'Mumbai':[19.1,72.9],
  'Delhi':[28.6,77.2],'Shanghai':[31.2,121.5],'Shenzhen':[22.5,114.1],
  'Auckland':[-36.8,174.8],'Papua New Guinea':[-6.3,147],
  // More Europe
  'Berlin':[52.5,13.4],'Paris':[48.9,2.3],'Madrid':[40.4,-3.7],
  'Rome':[41.9,12.5],'Warsaw':[52.2,21],'Prague':[50.1,14.4],
  'Vienna':[48.2,16.4],'Budapest':[47.5,19.1],'Bucharest':[44.4,26.1],
  'Kyiv':[50.4,30.5],'Oslo':[59.9,10.7],'Copenhagen':[55.7,12.6],
  'Brussels':[50.8,4.4],'Zurich':[47.4,8.5],'Dublin':[53.3,-6.3],
  'Lisbon':[38.7,-9.1],'Athens':[37.9,23.7],'Minsk':[53.9,27.6],
  // More Africa
  'Nairobi':[-1.3,36.8],'Lagos':[6.5,3.4],'Accra':[5.6,-0.2],
  'Addis Ababa':[9,38.7],'Cape Town':[-33.9,18.4],'Johannesburg':[-26.2,28],
  'Kinshasa':[-4.3,15.3],'Khartoum':[15.6,32.5],'Mogadishu':[2.1,45.3],
  'Dakar':[14.7,-17.5],'Abuja':[9.1,7.5],
  // Tech/Economy keywords with US locations
  'Fed':[38.9,-77],'Congress':[38.9,-77],'Senate':[38.9,-77],
  'Silicon Valley':[37.4,-122],'NASA':[28.6,-80.6],'Pentagon':[38.9,-77],
  'IMF':[38.9,-77],'World Bank':[38.9,-77],'UN':[40.7,-74],
};

function geoTagText(text) {
  if (!text) return null;
  for (const [keyword, [lat, lon]] of Object.entries(geoKeywords)) {
    if (text.includes(keyword)) {
      return { lat, lon, region: keyword };
    }
  }
  return null;
}

// === ACLED region centroids ===
// ACLED buckets every event into one of its own macro-regions. The dashboard's
// Conflict Events layer needs a plottable point per region, so mirror the
// coordinate tables jarvis.html already uses for its other geo layers.
const ACLED_REGION_CENTROIDS = {
  'western africa': [11, 0],
  'middle africa': [-2, 18],
  'eastern africa': [2, 38],
  'southern africa': [-25, 25],
  'northern africa': [27, 15],
  'north africa': [27, 15],
  'africa': [0, 20],
  'middle east': [29, 45],
  'caucasus and central asia': [42, 62],
  'central asia': [42, 62],
  'south asia': [22, 78],
  'southeast asia': [12, 105],
  'south-east asia': [12, 105],
  'east asia': [35, 115],
  'northeast asia': [40, 125],
  'europe': [50, 15],
  'eastern europe': [50, 32],
  'western europe': [48, 4],
  'northern europe': [60, 18],
  'southern europe': [42, 14],
  'caribbean': [18, -72],
  'central america': [15, -89],
  'central america and the caribbean': [16, -83],
  'south america': [-14, -60],
  'north america': [40, -100],
  'oceania': [-25, 140],
  'antarctica': [-75, 0],
};

function acledRegionCentroid(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const hit = ACLED_REGION_CENTROIDS[key];
  if (hit) return { lat: hit[0], lon: hit[1] };
  const geo = geoTagText(String(name));
  return geo ? { lat: geo.lat, lon: geo.lon } : null;
}

// Build the plottable `acled.regions` array the Conflict Events layer reads.
// `byRegion` is `{ [regionName]: { count, fatalities } }` from apis/sources/acled.mjs.
function buildAcledRegions(byRegion = {}, byType = {}) {
  const topType = Object.entries(byType)
    .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))[0]?.[0];
  return Object.entries(byRegion)
    .map(([region, stats]) => {
      const centroid = acledRegionCentroid(region);
      if (!centroid) return null;
      return {
        region,
        country: undefined,
        lat: centroid.lat,
        lon: centroid.lon,
        events: stats?.count || 0,
        fatalities: stats?.fatalities || 0,
        topType: stats?.topType || topType || undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.events - a.events);
}

// Stable string hash (djb2 xor) — used where a value must be reproducible
// across sweeps instead of re-randomised on every synthesize().
function hashString(value) {
  let hash = 5381;
  const str = String(value ?? '');
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  return hash >>> 0;
}

// Deterministic offset in [-0.5, 0.5) derived from `value`.
function stableJitter(value, salt) {
  return (hashString(`${salt}:${value}`) % 100000) / 100000 - 0.5;
}

// String.fromCodePoint throws RangeError on out-of-range values and silently
// produces lone surrogates for the D800-DFFF block; both come straight from
// untrusted feed markup, so drop them instead.
function safeCodePoint(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return '';
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return '';
  return String.fromCodePoint(codePoint);
}

function sanitizeExternalUrl(raw) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function decodeFeedText(raw = '') {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => safeCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => safeCodePoint(parseInt(value, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function sumAirHotspots(hotspots = []) {
  return hotspots.reduce((sum, hotspot) => sum + (hotspot.totalAircraft || 0), 0);
}

function summarizeAirHotspots(hotspots = []) {
  return hotspots.map(h => ({
    region: h.region,
    total: h.totalAircraft || 0,
    noCallsign: h.noCallsign || 0,
    highAlt: h.highAltitude || 0,
    status: h.status || (h.error ? 'failed' : h.totalAircraft > 0 ? 'healthy' : 'no_data'),
    observationNote: h.error || h.message || (h.totalAircraft > 0 ? null : 'No aircraft observations reported; this does not establish an empty sky'),
    top: Object.entries(h.byCountry || {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
  }));
}

function loadOpenSkyFallback(currentTimestamp) {
  const runsDir = join(ROOT, 'runs');
  if (!existsSync(runsDir)) return null;

  const currentMs = currentTimestamp ? new Date(currentTimestamp).getTime() : NaN;
  const files = readdirSync(runsDir)
    .filter(name => /^briefing_.*\.json$/.test(name))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = join(runsDir, file);
    try {
      const prior = JSON.parse(readFileSync(filePath, 'utf8'));
      const priorTimestamp = prior.sources?.OpenSky?.timestamp || prior.crucix?.timestamp || null;
      if (priorTimestamp && Number.isFinite(currentMs) && new Date(priorTimestamp).getTime() >= currentMs) continue;

      const hotspots = prior.sources?.OpenSky?.hotspots || [];
      if (sumAirHotspots(hotspots) > 0) {
        return { file, timestamp: priorTimestamp, hotspots };
      }
    } catch {
      // Ignore unreadable historical runs and continue searching backward.
    }
  }

  return null;
}

// === RSS Fetching ===
async function fetchRSS(url, source) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    const items = [];
    // RDF feeds (e.g. DW) use <item rdf:about="..."> and <dc:date> instead of plain <item>/<pubDate>
    const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = decodeFeedText(block.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1] || '');
      const link = sanitizeExternalUrl((block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1] || '').trim());
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]
        || block.match(/<dc:date>(.*?)<\/dc:date>/)?.[1] || '';
      const summary = decodeFeedText(
        block.match(/<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i)?.[1]
        || block.match(/<content:encoded(?:\s[^>]*)?>([\s\S]*?)<\/content:encoded>/i)?.[1]
        || ''
      );
      const publisher = decodeFeedText(
        block.match(/<dc:creator(?:\s[^>]*)?>([\s\S]*?)<\/dc:creator>/i)?.[1]
        || block.match(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/i)?.[1]
        || source
      );
      if (title && title !== source) {
        items.push({
          title,
          summary: summary || undefined,
          publisher: publisher || source,
          date: pubDate,
          source,
          url: link || undefined
        });
      }
    }
    return items;
  } catch (e) {
    console.log(`RSS fetch failed (${source}):`, e.message);
    return [];
  }
}

const RSS_SOURCE_FALLBACKS = {
  'SBS Australia': { lat: -35.2809, lon: 149.13, region: 'Australia' },
  'Indian Express': { lat: 28.6139, lon: 77.209, region: 'India' },
  'The Hindu': { lat: 13.0827, lon: 80.2707, region: 'India' },
  'MercoPress': { lat: -34.9011, lon: -56.1645, region: 'South America' }
};
const REGIONAL_NEWS_SOURCES = ['MercoPress', 'Indian Express', 'The Hindu', 'SBS Australia'];

export async function fetchAllNews() {
  const feeds = [
    // Global
    ['http://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'NYT'],
    ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
    // USA
    ['https://feeds.npr.org/1001/rss.xml', 'NPR'],
    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'],
    ['http://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'BBC Science'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml', 'NYT Americas'],
    // Europe
    ['https://rss.dw.com/rdf/rss-en-all', 'DW'],
    ['https://www.france24.com/en/rss', 'France 24'],
    ['https://www.euronews.com/rss?format=mrss', 'Euronews'],
    // Africa & Cameroon region
    ['https://rss.dw.com/rdf/rss-en-africa', 'DW Africa'],
    ['https://www.rfi.fr/en/rss', 'RFI'],
    ['https://www.africanews.com/feed/rss', 'Africa News'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml', 'NYT Africa'],
    // Asia-Pacific
    ['https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml', 'NYT Asia'],
    ['https://www.sbs.com.au/news/topic/australia/feed', 'SBS Australia'],
    // India
    ['https://indianexpress.com/section/india/feed/', 'Indian Express'],
    ['https://www.thehindu.com/news/national/feeder/default.rss', 'The Hindu'],
    // South America
    ['https://en.mercopress.com/rss/latin-america', 'MercoPress'],
  ];

  const results = await Promise.allSettled(
    feeds.map(([url, source]) => fetchRSS(url, source))
  );

  const allNews = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // De-duplicate and geo-tag
  const seen = new Set();
  const geoNews = [];
  for (const item of allNews) {
    const key = item.title.substring(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const geo = geoTagText(item.title) || RSS_SOURCE_FALLBACKS[item.source];
    if (geo) {
      geoNews.push({
        title: item.title.substring(0, 100),
        source: item.source,
        summary: item.summary,
        publisher: item.publisher || item.source,
        date: item.date,
        url: item.url,
        // Deterministic scatter so the same headline lands on the same point
        // across sweeps (markers stop jittering between renders).
        lat: geo.lat + stableJitter(item.title, 'lat') * 2,
        lon: geo.lon + stableJitter(item.title, 'lon') * 2,
        region: geo.region
      });
    }
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filtered = geoNews.filter(n => !n.date || new Date(n.date) >= cutoff);
  filtered.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.source}|${item.title}|${item.date}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  // Reserve a little space so newly-added regional feeds are not crowded out by larger globals.
  for (const source of REGIONAL_NEWS_SOURCES) {
    filtered.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  filtered.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === Leverageable Ideas from Signals ===
export function generateIdeas(V2) {
  const ideas = [];
  const vix = V2.fred.find(f => f.id === 'VIXCLS');
  const hy = V2.fred.find(f => f.id === 'BAMLH0A0HYM2');
  const spread = V2.fred.find(f => f.id === 'T10Y2Y');

  if (vix && vix.value > 20) {
    ideas.push({
      title: 'Elevated Volatility Regime',
      text: `VIX at ${vix.value} — fear premium elevated. Portfolio hedges justified. Short-term equity upside is capped.`,
      type: 'hedge', confidence: vix.value > 25 ? 'High' : 'Medium', horizon: 'tactical'
    });
  }
  if (vix && vix.value > 20 && hy && hy.value > 3) {
    ideas.push({
      title: 'Safe Haven Demand Rising',
      text: `VIX ${vix.value} + HY spread ${hy.value}% = risk-off building. Gold, treasuries, quality dividends may outperform.`,
      type: 'hedge', confidence: 'Medium', horizon: 'tactical'
    });
  }
  if (V2.energy.wtiRecent.length > 1) {
    const latest = V2.energy.wtiRecent.at(-1);
    const oldest = V2.energy.wtiRecent[0];
    const pct = ((latest - oldest) / oldest * 100).toFixed(1);
    if (oldest > 0 && Number.isFinite(+pct) && Math.abs(pct) > 3) {
      ideas.push({
        title: pct > 0 ? 'Oil Momentum Building' : 'Oil Under Pressure',
        text: `WTI moved ${pct > 0 ? '+' : ''}${pct}% recently to $${V2.energy.wti}/bbl. ${pct > 0 ? 'Energy and commodity names benefit.' : 'Demand concerns may be emerging.'}`,
        type: pct > 0 ? 'long' : 'watch', confidence: 'Medium', horizon: 'swing'
      });
    }
  }
  if (spread) {
    ideas.push({
      title: spread.value > 0 ? 'Yield Curve Normalizing' : 'Yield Curve Inverted',
      text: `10Y-2Y spread at ${spread.value.toFixed(2)}. ${spread.value > 0 ? 'Recession signal fading — cyclical rotation possible.' : 'Inversion persists — defensive positioning warranted.'}`,
      type: 'watch', confidence: 'Medium', horizon: 'strategic'
    });
  }
  const debt = parseFloat(V2.treasury.totalDebt);
  if (debt > 35e12) {
    ideas.push({
      title: 'Fiscal Trajectory Supports Hard Assets',
      text: `National debt at $${(debt / 1e12).toFixed(1)}T. Long-term gold, bitcoin, and real asset appreciation thesis intact.`,
      type: 'long', confidence: 'High', horizon: 'strategic'
    });
  }
  // Yield Curve + Labor Interaction
  const unemployment = V2.bls.find(b => b.id === 'LNS14000000' || b.id === 'UNRATE');
  const payrolls = V2.bls.find(b => b.id === 'CES0000000001' || b.id === 'PAYEMS');
  if (spread && unemployment && payrolls) {
    const weakLabor = (unemployment.value > 4.3) || (payrolls.momChange && payrolls.momChange < -50);
    if (spread.value > 0.3 && weakLabor) {
      ideas.push({
        title: 'Steepening Curve Meets Weak Labor',
        text: `10Y-2Y at ${spread.value.toFixed(2)} + UE ${unemployment.value}%. Curve steepening with deteriorating employment = recession positioning warranted.`,
        type: 'hedge', confidence: 'High', horizon: 'tactical'
      });
    }
  }

  // ACLED Conflict + Energy Momentum
  const conflictEvents = V2.acled?.totalEvents || 0;
  if (conflictEvents > 50 && V2.energy.wtiRecent.length > 1) {
    const wtiMove = V2.energy.wtiRecent.at(-1) - V2.energy.wtiRecent[0];
    if (wtiMove > 2) {
      ideas.push({
        title: 'Conflict Fueling Energy Momentum',
        text: `${conflictEvents} ACLED events this week + WTI up $${wtiMove.toFixed(1)}. Conflict-energy transmission channel active.`,
        type: 'long', confidence: 'Medium', horizon: 'swing'
      });
    }
  }

  // Defense + Conflict Intensity
  const totalFatalities = V2.acled?.totalFatalities || 0;
  const totalThermalAll = V2.thermal.reduce((s, t) => s + t.det, 0);
  if (totalFatalities > 500 && totalThermalAll > 20000) {
    ideas.push({
      title: 'Defense Procurement Acceleration Signal',
      text: `${totalFatalities.toLocaleString()} conflict fatalities + ${totalThermalAll.toLocaleString()} thermal detections. Defense contractors may see accelerated procurement.`,
      type: 'long', confidence: 'Medium', horizon: 'swing'
    });
  }

  // HY Spread + VIX Divergence
  if (hy && vix) {
    const hyWide = hy.value > 3.5;
    const vixLow = vix.value < 18;
    const hyTight = hy.value < 2.5;
    const vixHigh = vix.value > 25;
    if (hyWide && vixLow) {
      ideas.push({
        title: 'Credit Stress Ignored by Equity Vol',
        text: `HY spread ${hy.value.toFixed(1)}% (wide) but VIX only ${vix.value.toFixed(0)} (complacent). Equity may be underpricing credit deterioration.`,
        type: 'watch', confidence: 'Medium', horizon: 'tactical'
      });
    } else if (hyTight && vixHigh) {
      ideas.push({
        title: 'Equity Fear Exceeds Credit Stress',
        text: `VIX at ${vix.value.toFixed(0)} but HY spread only ${hy.value.toFixed(1)}%. Equity vol may be overshooting — credit markets aren't confirming.`,
        type: 'watch', confidence: 'Medium', horizon: 'tactical'
      });
    }
  }

  // Supply Chain + Inflation Pipeline
  const ppi = V2.bls.find(b => b.id === 'WPUFD49104' || b.id === 'PCU--PCU--');
  const cpi = V2.bls.find(b => b.id === 'CUUR0000SA0' || b.id === 'CPIAUCSL');
  if (ppi && cpi && V2.gscpi) {
    const supplyPressure = V2.gscpi.value > 0.5;
    const ppiRising = ppi.momChangePct > 0.3;
    if (supplyPressure && ppiRising) {
      ideas.push({
        title: 'Inflation Pipeline Building Pressure',
        text: `GSCPI at ${V2.gscpi.value.toFixed(2)} (${V2.gscpi.interpretation}) + PPI momentum +${ppi.momChangePct?.toFixed(1)}%. Input costs flowing through — CPI may follow.`,
        type: 'long', confidence: 'Medium', horizon: 'strategic'
      });
    }
  }

  return ideas.slice(0, 8);
}

// === Synthesize raw sweep data into dashboard format ===
export function chronologicalValues(rows, field) {
  return rows.filter(row => Number.isFinite(row[field]) && Number.isFinite(Date.parse(row.date || row.period)))
    .slice().sort((a, b) => Date.parse(a.date || a.period) - Date.parse(b.date || b.period))
    .map(row => row[field]);
}

export async function synthesize(data, { newsLoader = fetchAllNews, now = Date.now() } = {}) {
  // Re-evaluate old caches as well as new sweeps; pre-fix snapshots must not
  // resurrect years-old radiation alerts after a restart.
  const safecast = data.sources.Safecast;
  const nuke = (safecast?.sites || []).map(s => {
    const status = radiationState(s, now);
    return {
      site: s.site, status, lastReading: s.lastReading || null,
      anom: status === 'healthy' ? Boolean(s.anomaly) : null,
      cpm: status === 'healthy' ? s.avgCPM : null,
      uSvH: status === 'healthy' && Number.isFinite(s.avgUSvH) ? s.avgUSvH : null,
      n: status === 'healthy' ? s.recentReadings : 0,
      error: status === 'healthy' ? null : s.error || `Radiation observations are ${status}`,
    };
  });
  // The anomaly is decided in µSv/h; CPM depends on the tube, so it is only a fallback.
  const nukeSignals = nuke.filter(s => s.anom).map(s => `ELEVATED RADIATION at ${s.site}: ${
    Number.isFinite(s.uSvH) ? `${s.uSvH.toFixed(2)} µSv/h median` : `${s.cpm?.toFixed(1) ?? '--'} CPM`}`);
  // Sites with no sensors in range are permanent, declared gaps; they neither
  // block the all-clear nor count as a source outage.
  const covered = nuke.filter(s => s.status !== 'no_coverage');
  const uncovered = nuke.filter(s => s.status === 'no_coverage');
  if (covered.length && covered.every(s => s.status === 'healthy') && !nukeSignals.length) {
    nukeSignals.push(uncovered.length
      ? `Radiation normal at all ${covered.length} sites with sensor coverage (no sensors: ${uncovered.map(s => s.site).join(', ')})`
      : 'All monitored nuclear sites within normal radiation levels');
  }
  const sources = { ...data.sources };
  if (safecast && (!covered.length || covered.some(s => s.status !== 'healthy'))) {
    sources.Safecast = { ...safecast,
      status: covered.some(s => s.status === 'healthy') ? 'degraded' : covered.some(s => s.status === 'stale') ? 'stale' : 'failed',
      error: 'Some monitored sites have missing, failed or stale observations; current radiation conditions are unknown there.',
      lastObservationAt: nuke.map(s => s.lastReading).filter(Boolean).sort().at(-1) || null,
    };
  }
  const health = buildSourceHealth(sources, data.errors || [], data.sourceHealth || [], data.crucix?.timestamp);
  const liveAirHotspots = data.sources.OpenSky?.hotspots || [];
  const airFallback = sumAirHotspots(liveAirHotspots) > 0
    ? null
    : loadOpenSkyFallback(data.sources.OpenSky?.timestamp || data.crucix?.timestamp);
  const effectiveAirHotspots = airFallback?.hotspots || liveAirHotspots;
  const air = summarizeAirHotspots(effectiveAirHotspots);
  const thermal = (data.sources.FIRMS?.hotspots || []).map(h => ({
    region: h.region, det: h.totalDetections || 0, night: h.nightDetections || 0,
    hc: h.highConfidence || 0,
    fires: (h.highIntensity || []).slice(0, 8).map(f => ({ lat: f.lat, lon: f.lon, frp: f.frp || 0 }))
  }));
  const tSignals = data.sources.FIRMS?.signals || [];
  const chokepoints = Object.values(data.sources.Maritime?.chokepoints || {}).map(c => ({
    label: c.label || c.name, note: c.note || '', lat: c.lat || 0, lon: c.lon || 0
  }));
  const sdrData = data.sources.KiwiSDR || {};
  const sdrNet = sdrData.network || {};
  const sdrConflict = sdrData.conflictZones || {};
  const sdrZones = Object.values(sdrConflict).map(z => ({
    region: z.region, count: z.count || 0,
    receivers: (z.receivers || []).slice(0, 5).map(r => ({ name: r.name || '', lat: r.lat || 0, lon: r.lon || 0 }))
  }));
  const who = (data.sources.WHO?.diseaseOutbreakNews || []).slice(0, 10).map(w => ({
    title: w.title?.substring(0, 120), date: w.date, summary: w.summary?.substring(0, 150),
    // Keep the bulletin link so the OSINT panel can render "Open source".
    url: sanitizeExternalUrl(w.url)
  }));
  const fred = (data.sources.FRED?.indicators || []).map(f => ({
    id: f.id, label: f.label, value: f.value, date: f.date,
    recent: f.recent || [],
    momChange: f.momChange, momChangePct: f.momChangePct
  }));
  const energyData = data.sources.EIA || {};
  const oilPrices = energyData.oilPrices || {};
  // Every history exposed to the page/idea engine is chronological.
  const wtiRecent = chronologicalValues(oilPrices.wti?.recent || [], 'value');
  const energy = {
    wti: oilPrices.wti?.value, brent: oilPrices.brent?.value,
    natgas: energyData.gasPrice?.value, crudeStocks: energyData.inventories?.crudeStocks?.value,
    wtiRecent, signals: energyData.signals || []
  };
  const bls = data.sources.BLS?.indicators || [];
  const treasuryData = data.sources.Treasury || {};
  const debtArr = treasuryData.debt || [];
  const treasury = { totalDebt: debtArr[0]?.totalDebt ?? null, signals: treasuryData.signals || [] };
  const gscpi = data.sources.GSCPI?.latest || null;
  const defense = (data.sources.USAspending?.recentDefenseContracts || []).slice(0, 5).map(c => ({
    recipient: c.recipient?.substring(0, 40), amount: c.amount, desc: c.description?.substring(0, 80)
  }));
  const noaa = {
    totalAlerts: data.sources.NOAA?.totalSevereAlerts ?? null,
    alerts: (data.sources.NOAA?.topAlerts || []).filter(a => a.lat != null && a.lon != null).slice(0, 10).map(a => ({
      event: a.event, severity: a.severity, headline: a.headline?.substring(0, 120),
      lat: a.lat, lon: a.lon
    }))
  };

  // EPA RadNet — pass through geo-tagged readings
  const epaData = data.sources.EPA || {};
  const epaStations = [];
  const seenEpa = new Set();
  for (const r of (epaData.readings || [])) {
    if (r.lat == null || r.lon == null) continue;
    const key = `${r.lat},${r.lon}`;
    if (seenEpa.has(key)) continue;
    seenEpa.add(key);
    epaStations.push({ location: r.location, state: r.state, lat: r.lat, lon: r.lon, analyte: r.analyte, result: r.result, unit: r.unit });
  }
  const epa = { totalReadings: epaData.totalReadings ?? null, stations: epaStations.slice(0, 10) };

  // Radiation-EU — European state dose-rate networks (BfS + STUK) as a
  // background layer. Stations arrive pre-thinned to one per grid cell.
  const radEu = data.sources['Radiation-EU'] || {};
  const radBackground = {
    status: radEu.status || (data.sources['Radiation-EU'] ? 'healthy' : 'failed'),
    networks: (radEu.networks || []).map(n => ({
      network: n.network, status: n.status, stations: n.stations || 0, fresh: n.fresh || 0,
      medianUSvH: Number.isFinite(n.medianUSvH) ? n.medianUSvH : null,
      maxUSvH: Number.isFinite(n.maxUSvH) ? n.maxUSvH : null,
      maxStation: n.maxStation?.name || null, lastObservationAt: n.lastObservationAt || null,
    })),
    stationsFresh: radEu.stationsFresh || 0,
    medianUSvH: Number.isFinite(radEu.medianUSvH) ? radEu.medianUSvH : null,
    maxUSvH: Number.isFinite(radEu.maxUSvH) ? radEu.maxUSvH : null,
    anomaly: typeof radEu.anomaly === 'boolean' ? radEu.anomaly : null,
    elevatedCount: radEu.elevatedCount ?? (radEu.elevated || []).length,
    elevated: (radEu.elevated || []).slice(0, 10),
    risingCount: Number.isFinite(radEu.risingCount) ? radEu.risingCount : null,
    rising: (radEu.rising || []).slice(0, 10),
    baselineStations: radEu.baselineStations || 0,
    stations: (radEu.stations || []).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon)).slice(0, 600),
    signals: radEu.signals || [],
    lastObservationAt: radEu.lastObservationAt || null,
    error: radEu.error || null,
  };

  // Space/CelesTrak satellite data
  const spaceData = data.sources.Space || {};
  // Subsatellite point via SGP4 — the Space source provides raw TLE lines (line1/line2),
  // not orbital elements, so propagate with satellite.js like lib/space/satellitePasses.mjs.
  function tleSubpoint(sat) {
    if (!sat?.line1 || !sat?.line2) return null;
    try {
      const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
      const now = new Date();
      const posVel = satellite.propagate(satrec, now);
      if (!posVel?.position || typeof posVel.position === 'boolean' || satrec.error !== 0) return null;
      const geo = satellite.eciToGeodetic(posVel.position, satellite.gstime(now));
      const lat = satellite.radiansToDegrees(geo.latitude);
      const lon = satellite.radiansToDegrees(geo.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat: +lat.toFixed(2), lon: +(((lon % 360) + 540) % 360 - 180).toFixed(2), name: sat.name };
    } catch {
      return null;
    }
  }
  const issPos = tleSubpoint(spaceData.iss);
  const seenSats = new Set();
  const spaceStations = [];
  for (const sat of [spaceData.iss, ...(spaceData.spaceStations || [])]) {
    const key = sat?.noradId ?? sat?.name;
    if (key == null || seenSats.has(key)) continue;
    seenSats.add(key);
    const pos = tleSubpoint(sat);
    if (pos) spaceStations.push(pos);
  }
  // Orbit geometry: pass apogee/perigee/altitudeKm through when the Space source
  // supplies them, and derive the mean altitude when only apogee+perigee exist.
  // Never fabricate a number — the dashboard renders '--' for a missing value.
  const issRaw = spaceData.iss || null;
  const issApogee = Number.isFinite(+issRaw?.apogee) ? +issRaw.apogee : undefined;
  const issPerigee = Number.isFinite(+issRaw?.perigee) ? +issRaw.perigee : undefined;
  const issAltitudeKm = Number.isFinite(+issRaw?.altitudeKm)
    ? +issRaw.altitudeKm
    : (issApogee !== undefined && issPerigee !== undefined ? (issApogee + issPerigee) / 2 : undefined);
  const iss = issRaw ? {
    ...issRaw,
    ...(issApogee !== undefined ? { apogee: issApogee } : {}),
    ...(issPerigee !== undefined ? { perigee: issPerigee } : {}),
    ...(issAltitudeKm !== undefined ? { altitudeKm: issAltitudeKm } : {}),
  } : null;

  const space = {
    totalNewObjects: spaceData.totalNewObjects || 0,
    militarySats: spaceData.militarySatellites || 0,
    militaryByCountry: spaceData.militaryByCountry || {},
    constellations: spaceData.constellations || {},
    iss,
    issPosition: issPos,
    stationPositions: spaceStations.slice(0, 6), // ISS + up to 5 stations
    recentLaunches: (spaceData.recentLaunches || []).slice(0, 10).map(l => ({
      name: l.name, country: l.country, epoch: l.epoch,
      apogee: l.apogee, perigee: l.perigee, type: l.objectType
    })),
    launchByCountry: spaceData.launchByCountry || {},
    signals: spaceData.signals || [],
  };

  // ACLED conflict events
  const acledData = data.sources.ACLED || {};
  const acled = sourceState(data.sources.ACLED) !== 'healthy' ? { totalEvents: null, totalFatalities: null, byRegion: {}, byType: {}, regions: [], deadliestEvents: [] } : {
    totalEvents: acledData.totalEvents ?? null,
    totalFatalities: acledData.totalFatalities ?? null,
    byRegion: acledData.byRegion || {},
    byType: acledData.byType || {},
    // Plottable per-region rollup for the Conflict Events sensor layer.
    regions: buildAcledRegions(acledData.byRegion || {}, acledData.byType || {}),
    deadliestEvents: (acledData.deadliestEvents || []).slice(0, 15).map(e => ({
      date: e.date, type: e.type, country: e.country, location: e.location,
      fatalities: e.fatalities || 0, lat: e.lat || null, lon: e.lon || null
    }))
  };

  // GDELT news articles + geo events
  const gdeltData = data.sources.GDELT || {};
  const gdelt = {
    totalArticles: gdeltData.totalArticles || 0,
    conflicts: (gdeltData.conflicts || []).length,
    economy: (gdeltData.economy || []).length,
    health: (gdeltData.health || []).length,
    crisis: (gdeltData.crisis || []).length,
    topTitles: (gdeltData.allArticles || []).slice(0, 5).map(a => a.title?.substring(0, 80)),
    geoPoints: (gdeltData.geoPoints || []).slice(0, 20).map(p => ({
      lat: p.lat, lon: p.lon, name: (p.name || '').substring(0, 80), count: p.count || 1
    }))
  };

  // Sources that fail outright land in data.errors (not data.sources) —
  // include them or the dashboard reports "No failed sources" next to 27/29.

  // === Yahoo Finance live market data ===
  const yfData = data.sources.YFinance || {};
  const yfQuotes = yfData.quotes || {};
  const markets = {
    indexes: (yfData.indexes || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct, history: q.history || []
    })),
    rates: (yfData.rates || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct
    })),
    commodities: (yfData.commodities || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct, history: q.history || []
    })),
    crypto: (yfData.crypto || []).map(q => ({
      symbol: q.symbol, name: q.name, price: q.price,
      change: q.change, changePct: q.changePct
    })),
    vix: yfQuotes['^VIX'] ? {
      value: yfQuotes['^VIX'].price,
      change: yfQuotes['^VIX'].change,
      changePct: yfQuotes['^VIX'].changePct,
    } : null,
    timestamp: yfData.summary?.timestamp || null,
  };

  // Override stale EIA prices with live Yahoo Finance data if available
  const yfWti = yfQuotes['CL=F'];
  const yfBrent = yfQuotes['BZ=F'];
  const yfNatgas = yfQuotes['NG=F'];
  if (yfWti?.price) energy.wti = yfWti.price;
  if (yfBrent?.price) energy.brent = yfBrent.price;
  if (yfNatgas?.price) energy.natgas = yfNatgas.price;
  if (yfWti?.history?.length) energy.wtiRecent = chronologicalValues(yfWti.history, 'close');

  // Fetch RSS
  const news = await newsLoader();

  const V2 = {
    meta: { ...data.crucix, ...sourceCounts(health), dataQualityVersion: 1 }, air, thermal, tSignals, chokepoints, nuke, nukeSignals,
    airMeta: {
      fallback: Boolean(airFallback),
      liveTotal: sumAirHotspots(liveAirHotspots),
      timestamp: airFallback?.timestamp || data.sources.OpenSky?.timestamp || data.crucix?.timestamp || null,
      source: airFallback ? 'OpenSky fallback' : 'OpenSky',
      ...(airFallback ? { fallbackFile: airFallback.file } : {}),
      ...(data.sources.OpenSky?.error ? { error: data.sources.OpenSky.error } : {}),
    },
    sdr: { total: sdrNet.totalReceivers || 0, online: sdrNet.online || 0, zones: sdrZones },
    who, fred, energy, bls, treasury, gscpi, defense, noaa, epa, radBackground, acled, gdelt, space, health, news,
    markets, // Live Yahoo Finance market data
    ideas: [], ideasSource: 'disabled', ideasMode: 'disabled', ideasGeneratedAt: null, // server.mjs overrides after the LLM step
    // newsFeed for ticker (merged RSS + GDELT)
    newsFeed: buildNewsFeed(news, gdeltData),
  };

  return V2;
}

export function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// === Unified News Feed for Ticker ===
export function buildNewsFeed(rssNews, gdeltData) {
  const feed = [];

  // RSS news
  for (const n of rssNews) {
    feed.push({
      headline: n.title, source: n.source, type: 'rss',
      summary: n.summary || n.description,
      publisher: n.publisher || n.source,
      timestamp: n.date, region: n.region, urgent: false, url: sanitizeExternalUrl(n.url)
    });
  }

  // GDELT top articles
  for (const a of (gdeltData.allArticles || []).slice(0, 10)) {
    if (a.title) {
      const geo = geoTagText(a.title);
      feed.push({
        headline: a.title.substring(0, 100), source: 'GDELT', type: 'gdelt',
        summary: a.summary || a.description,
        publisher: a.domain || a.publisher || a.source || 'GDELT',
        timestamp: a.date || a.timestamp || new Date().toISOString(),
        region: geo?.region || 'Global', urgent: false, url: sanitizeExternalUrl(a.url)
      });
    }
  }

  // Filter to last 30 days, sort by timestamp descending, limit to 50
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = feed.filter(item => !item.timestamp || new Date(item.timestamp) >= cutoff);
  recent.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.type}|${item.source}|${item.headline}|${item.timestamp}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  for (const source of REGIONAL_NEWS_SOURCES) {
    recent.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  recent.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === CLI Mode: inject into HTML file ===
function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

async function cliInject() {
  const data = JSON.parse(readFileSync(join(ROOT, 'runs/latest.json'), 'utf8'));
  const htmlOverride = getCliArg('--html');
  const shouldOpen = !process.argv.includes('--no-open');

  console.log('Fetching RSS news feeds...');
  const V2 = await synthesize(data);
  const llmProvider = createLLMProvider(config.llm);

  if (llmProvider?.isConfigured) {
    try {
      console.log(`[LLM] Generating ideas via ${llmProvider.name}...`);
      const llmIdeas = await generateLLMIdeas(llmProvider, V2, null, []);
      if (llmIdeas?.length) {
        V2.ideas = llmIdeas;
        V2.ideasSource = 'llm';
        console.log(`[LLM] Generated ${llmIdeas.length} ideas`);
      } else {
        V2.ideas = generateIdeas(V2);
        V2.ideasSource = 'llm-failed';
        console.log('[LLM] No ideas returned — using rule-based fallback');
      }
    } catch (err) {
      V2.ideas = generateIdeas(V2);
      V2.ideasSource = 'llm-failed';
      console.log('[LLM] Idea generation failed:', err.message, '— using rule-based fallback');
    }
  } else {
    V2.ideas = generateIdeas(V2);
    V2.ideasSource = 'disabled';
  }
  console.log(`Generated ${V2.ideas.length} leverageable ideas`);

  const json = serializeForInlineScript(V2);
  console.log('\n--- Synthesis ---');
  console.log('Size:', json.length, 'bytes | Air:', V2.air.length, '| Thermal:', V2.thermal.length,
    '| News:', V2.news.length, '| Ideas:', V2.ideas.length, '| Sources:', V2.health.length);

  // Read the git-tracked template, but NEVER write back to it — the served page
  // fetches /api/data at runtime, so the only reason to inline a data blob is the
  // standalone file:// snapshot. That goes to an untracked sibling file.
  const templatePath = join(ROOT, 'dashboard/public/jarvis.html');
  const outPath = htmlOverride || join(ROOT, 'dashboard/public/jarvis.injected.html');
  let html = readFileSync(templatePath, 'utf8');
  // Use a replacer function so JSON is inserted literally even if it contains `$`.
  html = html.replace(/^(let|const) D = .*;\s*$/m, () => 'let D = ' + json + ';');
  writeFileSync(outPath, html);
  console.log(`Data injected into ${outPath} (template ${templatePath} left untouched)`);
  const htmlPath = outPath;

  if (!shouldOpen) return;

  // Auto-open dashboard in default browser
  // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
  // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
  const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
  const dashUrl = htmlPath.replace(/\\/g, '/');
  exec(`${openCmd} "${dashUrl}"`, (err) => {
    if (err) console.log('Could not auto-open browser:', err.message);
    else console.log('Dashboard opened in browser!');
  });
}

// Run CLI if invoked directly
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) {
  await cliInject();
}
