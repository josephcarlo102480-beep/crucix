/**
 * CCTV public-camera registry (Module B).
 *
 * Ported from OSIRIS:
 *   - src/lib/stealthFetch.ts          (UA-rotating fetch wrapper)
 *   - src/app/api/cctv/route.ts        (region fetchers + region mapping)
 *   - src/app/api/cctv/types.ts        (feed-url helpers)
 *   - src/app/api/cctv/<country>.ts    (per-country camera lists/fetchers)
 *
 * Source URLs, endpoints and curated camera lists are copied verbatim from
 * OSIRIS. Only the TypeScript types were stripped and the Next.js route
 * wrapper replaced (see cctvRouter.mjs). Camera locations are effectively
 * static, so the fully-assembled list is cached for 12 hours.
 *
 * Camera object shape (verbatim from OSIRIS — note `lng`, not `lon`):
 *   { id, lat, lng, name, city, country, source,
 *     feed_url?, stream_url?, stream_type?, external_url? }
 */

// ═══ Tunable: cap on the assembled global camera set ═══
// The raw set is ~3,400 cameras (mostly long tails of ASFINAG/TfL), which is
// far more than a phone client needs. We round-robin across sources and keep
// the first MAX_CAMERAS so every source stays represented (global spread)
// while the bulky sources get trimmed. Bump this to widen coverage.
const MAX_CAMERAS = 400;

// ═══ stealthFetch (ported from src/lib/stealthFetch.ts) ═══
// NOTE: in OSIRIS the "residential IP" generator's output is never injected
// into the outgoing headers, so the real behaviour is User-Agent rotation
// plus a fixed Accept-Language. Ported faithfully (behaviour-preserving).
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
];

function randomInt(max) {
  return Math.floor(Math.random() * (max + 1));
}

function randomUA() {
  return USER_AGENTS[randomInt(USER_AGENTS.length - 1)];
}

export function stealthHeaders(extraHeaders) {
  return {
    'User-Agent': randomUA(),
    'Accept-Language': 'en-US,en;q=0.9',
    ...(extraHeaders || {}),
  };
}

export function stealthFetch(url, init = {}) {
  const extra = init.headers
    ? (init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : Array.isArray(init.headers)
          ? Object.fromEntries(init.headers)
          : init.headers)
    : undefined;
  return fetch(url, { ...init, headers: stealthHeaders(extra) });
}

// ═══ types helpers (ported from src/app/api/cctv/types.ts) ═══
export function normalizeFeedUrl(url) {
  if (url.startsWith('pics/')) {
    return `http://free-webcambg.com/${url.split('?')[0]}`;
  }
  return url.split('?')[0];
}

export function inferStreamType(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/youtube\.com\/embed|youtube-nocookie\.com\/embed|rtsp\.me\/embed|ipcamlive\.com\/player|click2stream\.com|windy\.com\/webcams\/\d+\/embed/i.test(url)) {
    return 'iframe';
  }
  return 'jpg';
}

// ═══ CAMERA SOURCE DEFINITIONS (ported from src/app/api/cctv/route.ts) ═══

// ── UK: Transport for London JamCams (~900) ──
async function fetchTfLCameras() {
  try {
    const res = await stealthFetch('https://api.tfl.gov.uk/Place/Type/JamCam', { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((cam) => {
      const imgProp = cam.additionalProperties?.find((p) => p.key === 'imageUrl');
      const camId = cam.id?.replace('JamCams_', '') || '';
      return {
        id: `tfl-${cam.id}`, lat: cam.lat, lng: cam.lon,
        name: cam.commonName || 'London JamCam', city: 'London', country: 'UK',
        feed_url: imgProp?.value || `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${camId}.jpg`,
        source: 'TfL',
      };
    }).filter((c) => c.lat && c.lng);
  } catch { return []; }
}

// ── US-WEST: WSDOT Washington State (~500) ──
async function fetchWSDOTCameras() {
  try {
    const res = await stealthFetch('https://data.wsdot.wa.gov/log/public/cameras.json', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map((cam) => ({
      id: `wsdot-${cam.CameraID}`, lat: cam.CameraLocation?.Latitude, lng: cam.CameraLocation?.Longitude,
      name: cam.Title || 'WSDOT Camera', city: 'Washington', country: 'US',
      feed_url: cam.ImageURL || '', source: 'WSDOT',
    })).filter((c) => c.lat && c.lng && c.feed_url);
  } catch { return []; }
}

// ── US-WEST: Caltrans California Districts ──
async function fetchCaltransCameras() {
  const allCams = [];
  for (const dist of ['d03', 'd04', 'd05', 'd06', 'd07', 'd08', 'd10', 'd11', 'd12']) {
    try {
      const res = await stealthFetch(`https://cwwp2.dot.ca.gov/data/${dist}/cctv/cctvStatus${dist.toUpperCase()}.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const cam of (data?.data || [])) {
        const lat = parseFloat(cam.location?.latitude);
        const lng = parseFloat(cam.location?.longitude);
        const url = cam.cctv?.imageData?.static?.currentImageURL;
        if (!lat || !lng || !url) continue;
        allCams.push({ id: `cal-${allCams.length}`, lat, lng, name: cam.location?.locationName || 'Caltrans', city: 'California', country: 'US', feed_url: url, source: 'Caltrans' });
      }
    } catch { /* silent */ }
  }
  return allCams;
}

// ── CANADA: Ottawa, Toronto, Montreal ──
async function fetchCanadaCameras() {
  const cams = [];

  // Ottawa MTO Highway Cameras
  try {
    const res = await stealthFetch('https://511on.ca/api/v2/get/cameras', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `on-${cam.id || cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || cam.name || 'Ontario Camera', city: 'Ontario', country: 'Canada',
          feed_url: cam.imageUrl || cam.url || '', source: '511 Ontario',
        });
      }
    }
  } catch { /* silent */ }

  // Ville de Montréal cameras
  try {
    const res = await stealthFetch('https://ville.montreal.qc.ca/circulation/sites/ville.montreal.qc.ca.circulation/files/cameras.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        cams.push({
          id: `mtl-${cams.length}`, lat: cam.latitude || cam.lat, lng: cam.longitude || cam.lng,
          name: cam.description || cam.name || 'Montréal Camera', city: 'Montréal', country: 'Canada',
          feed_url: cam.url || cam.imageUrl || '', source: 'Ville MTL',
        });
      }
    }
  } catch { /* silent */ }

  // Curated Ottawa/Toronto cameras from known public feeds
  const curated = [
    { id: 'ott-1', lat: 45.4215, lng: -75.6972, name: 'Parliament Hill / Wellington', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=1', source: 'Ottawa' },
    { id: 'ott-2', lat: 45.4231, lng: -75.6831, name: 'Rideau / Sussex', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=2', source: 'Ottawa' },
    { id: 'ott-3', lat: 45.4195, lng: -75.7009, name: 'Bank / Sparks', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=3', source: 'Ottawa' },
    { id: 'ott-4', lat: 45.4249, lng: -75.6950, name: 'King Edward / Rideau', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=4', source: 'Ottawa' },
    { id: 'ott-5', lat: 45.3968, lng: -75.7398, name: 'Merivale / Baseline', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=5', source: 'Ottawa' },
    { id: 'ott-6', lat: 45.3484, lng: -75.7580, name: 'Fallowfield / Woodroffe', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=6', source: 'Ottawa' },
    { id: 'ott-7', lat: 45.4012, lng: -75.6518, name: 'Hwy 417 / Vanier Pkwy', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=7', source: 'Ottawa' },
    { id: 'ott-8', lat: 45.4475, lng: -75.4822, name: 'Innes / Orleans Blvd', city: 'Ottawa', country: 'Canada', feed_url: 'https://traffic.ottawa.ca/map/camera?id=8', source: 'Ottawa' },
    { id: 'tor-1', lat: 43.6532, lng: -79.3832, name: 'Yonge / Dundas Square', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
    { id: 'tor-2', lat: 43.6426, lng: -79.3871, name: 'CN Tower / Lakeshore', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
    { id: 'tor-3', lat: 43.6711, lng: -79.3868, name: 'Bloor / Yonge', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
  ];
  cams.push(...curated);

  // Alberta 511
  try {
    const res = await stealthFetch('https://511.alberta.ca/api/v2/get/cameras', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.Latitude || !cam.Longitude || !cam.Views?.[0]?.Url) continue;
        cams.push({
          id: `ab-${cam.Id || cams.length}`, lat: cam.Latitude, lng: cam.Longitude,
          name: cam.Location || 'Alberta Camera', city: 'Alberta', country: 'Canada',
          feed_url: cam.Views[0].Url, source: 'Alberta 511',
        });
      }
    }
  } catch { /* silent */ }

  return cams.filter((c) => c.lat && c.lng);
}

// ── US-CENTRAL: Chicago, Houston, Dallas, Denver ──
async function fetchUSCentralCameras() {
  const cams = [];
  // Illinois DOT
  try {
    const res = await stealthFetch('https://www.travelmidwest.com/lmiga/cameraReport.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data?.cameraReports || data || []).slice(0, 800)) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `ildot-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.cameraName || cam.description || 'IDOT Camera', city: 'Illinois', country: 'US',
          feed_url: cam.imageUrl || cam.url || '', source: 'IDOT',
        });
      }
    }
  } catch { /* silent */ }

  return cams.filter((c) => c.lat && c.lng);
}

// ── US-EAST: OH, DC, Florida, Georgia ──
async function fetchUSEastCameras() {
  const cams = [];

  // Butler County, OH (from redhunt45 fork)
  cams.push(
    {
      id: 'butler-oh-hamilton', lat: 39.3988617, lng: -84.5595353,
      name: 'Hamilton, OH', city: 'Hamilton', country: 'US',
      feed_url: 'https://gsccam.butlersheriff.org/axis-cgi/jpg/image.cgi',
      external_url: 'https://gsccam.butlersheriff.org/camera/index.html#/video',
      source: 'Butler County, OH',
    },
    {
      id: 'butler-oh-129-747', lat: 39.381435, lng: -84.438423,
      name: 'OH-129 at 747', city: 'Butler County', country: 'US',
      feed_url: 'https://towercam.butlersheriff.org/axis-cgi/jpg/image.cgi',
      external_url: 'https://towercam.butlersheriff.org/aca/index.html#view',
      source: 'Butler County, OH',
    },
  );

  // Cincinnati, OH (from redhunt45 fork)
  cams.push(
    {
      id: 'cincinnati-cincyvision-yt', lat: 39.089101, lng: -84.527943,
      name: 'CincyVision YT', city: 'Cincinnati', country: 'US',
      external_url: 'https://www.youtube.com/@AaronPreslin/live',
      source: 'Cincinnati, OH',
    },
    {
      id: 'cincinnati-covington-earthcam', lat: 39.090510, lng: -84.510413,
      name: 'Cincinnati-Covington EarthCam', city: 'Covington', country: 'US',
      external_url: 'https://www.earthcam.com/usa/kentucky/covington/?cam=covington',
      source: 'Cincinnati, OH',
    },
  );
  // Florida 511
  try {
    const res = await stealthFetch('https://fl511.com/api/v2/cameras', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || []).slice(0, 800)) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `fl-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || 'FL-511 Camera', city: 'Florida', country: 'US',
          feed_url: cam.imageUrl || '', source: 'FL-511',
        });
      }
    }
  } catch { /* silent */ }

  return cams.filter((c) => c.lat && c.lng);
}

// ── EUROPE: Netherlands, Germany, France ──
async function fetchEuropeCameras() {
  const cams = [];

  // Netherlands Rijkswaterstaat
  try {
    const res = await stealthFetch('https://opendata.ndw.nu/cameras.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const cam of (data || []).slice(0, 1000)) {
        if (!cam.lat || !cam.lng) continue;
        cams.push({
          id: `nl-${cams.length}`, lat: cam.lat, lng: cam.lng,
          name: cam.name || 'NL Camera', city: 'Netherlands', country: 'NL',
          feed_url: cam.imageUrl || '', source: 'RWS',
        });
      }
    }
  } catch { /* silent */ }

  cams.push(...await fetchAsfinagCameras());

  return cams.filter((c) => c.lat && c.lng);
}

// ── ASIA/PACIFIC ──
async function fetchAsiaCameras() {
  const cams = [];

  // Singapore Live Traffic Images
  try {
    const res = await stealthFetch('https://api.data.gov.sg/v1/transport/traffic-images', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const items = data.items?.[0]?.cameras || [];
      for (const cam of items) {
        if (!cam.location?.latitude || !cam.location?.longitude || !cam.image) continue;
        cams.push({
          id: `sin-${cam.camera_id}`,
          lat: cam.location.latitude,
          lng: cam.location.longitude,
          name: `Camera ${cam.camera_id}`,
          city: 'Singapore',
          country: 'Singapore',
          feed_url: cam.image,
          source: 'LTA Singapore',
        });
      }
    }
  } catch { /* silent */ }

  return cams;
}

// ── MIDDLE EAST: Israel, Lebanon ──
async function fetchMiddleEastCameras() {
  const cams = [];

  // Israel Curated (Embedded)
  cams.push(
    {
      id: 'il-israel-multicam', lat: 32.0853, lng: 34.7818,
      name: 'Israel Multi-Cam (Live)', city: 'Tel Aviv', country: 'Israel',
      stream_url: 'https://www.youtube.com/embed/gmtlJ_m2r5A?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    },
    {
      id: 'il-jerusalem-live', lat: 31.7767, lng: 35.2345,
      name: 'Jerusalem Western Wall', city: 'Jerusalem', country: 'Israel',
      stream_url: 'https://www.youtube.com/embed/77akujLn4k8?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    }
  );

  // Lebanon Curated (Embedded)
  cams.push(
    {
      id: 'lb-beirut-skyline', lat: 33.8938, lng: 35.5018,
      name: 'Beirut Skyline Live', city: 'Beirut', country: 'Lebanon',
      stream_url: 'https://www.youtube.com/embed/qJf4NqPKLjI?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    },
    {
      id: 'lb-me-multicam', lat: 33.2721, lng: 35.2033,
      name: 'Middle East Multi-Cam (Live)', city: 'Regional', country: 'Middle East',
      stream_url: 'https://www.youtube.com/embed/oxT5R6I0N6E?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    }
  );

  return cams;
}

// ── AUSTRALIA (ported from australia.ts) ──
async function fetchAustraliaCameras() {
  try {
    const res = await fetch('https://www.livetraffic.com/datajson/all-feeds-web.json', { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).filter((event) => event.eventType === 'liveCams').map((cam) => ({
      id: cam.path,
      lat: cam.geometry.coordinates[1],
      lng: cam.geometry.coordinates[0],
      name: cam.properties.title || 'Australia Camera',
      city: cam.properties.region || 'Australia',
      country: 'Australia',
      feed_url: cam.properties.href || '',
      source: 'Live Traffic',
    })).filter((c) => c.lat && c.lng);
  } catch { return []; }
}

// ── ASFINAG (ported from asfinag.ts, self-cached 1h) ──
const ASFINAG_WEBCAMS_URL = 'https://odo.asfinag.at/odo/rest/sec/resource/001/json/webcams?language=atDE';
const ASFINAG_CACHE_TTL_MS = 60 * 60 * 1000;
const ASFINAG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'Accept': 'application/json',
  'Accept-Language': 'en,en-US;q=0.9,de;q=0.8',
  'Referer': 'https://www.asfinag.at/',
  'Content-Type': 'application/json; charset=utf-8',
  'Authorization': 'Basic bWFwX3dpZGdldDp0ZWdkaXc=',
  'Origin': 'https://www.asfinag.at',
};
let asfinagCached = null;
let asfinagExpiresAt = 0;
let asfinagPending = null;

function toAsfinagCamera(cam) {
  if (!cam.wcs_id || !cam.wgs84_lat || !cam.wgs84_lon || !cam.url_campic) return null;
  // Skip Hungarian road authority (Utinform) cameras — feeds are unavailable
  if (cam.wcs_id.startsWith('Utinform')) return null;
  return {
    id: `asfinag-${cam.wcs_id}`,
    lat: cam.wgs84_lat,
    lng: cam.wgs84_lon,
    name: cam.position_txt || cam.direction_txt || 'ASFINAG Webcam',
    city: 'Austria',
    country: 'Austria',
    feed_url: cam.url_campic,
    source: 'ASFINAG',
  };
}

async function fetchFreshAsfinagCameras() {
  try {
    const res = await fetch(ASFINAG_WEBCAMS_URL, { signal: AbortSignal.timeout(12000), headers: ASFINAG_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(toAsfinagCamera).filter((cam) => cam !== null);
  } catch {
    return [];
  }
}

async function fetchAsfinagCameras() {
  const now = Date.now();
  if (asfinagCached && now < asfinagExpiresAt) return asfinagCached;
  if (!asfinagPending) {
    asfinagPending = fetchFreshAsfinagCameras()
      .then((cameras) => {
        if (cameras.length > 0) {
          asfinagCached = cameras;
          asfinagExpiresAt = Date.now() + ASFINAG_CACHE_TTL_MS;
        }
        return asfinagCached ?? cameras;
      })
      .finally(() => { asfinagPending = null; });
  }
  return asfinagPending;
}

// ── Curated per-country lists (ported from <country>.ts) ──
function dedupeByKey(cams) {
  const seen = new Set();
  const merged = [];
  for (const cam of cams) {
    if (!cam.feed_url && !cam.stream_url && !cam.external_url) continue;
    const key = (cam.stream_url || cam.feed_url || cam.external_url || cam.id).split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cam);
  }
  return merged;
}

async function fetchBulgariaCameras() {
  const BULGARIA_MANUAL = [
    { id: 'bg-sofia-tsarigradsko-uab', lat: 42.662, lng: 23.376, name: 'Tsarigradsko Shose (UAB)', city: 'Sofia', country: 'Bulgaria', feed_url: 'https://cdn.uab.org/images/cctv/images/cctv/cctv_103/cctv.jpg', source: 'UAB / KAMEPA' },
    { id: 'bg-sofia-banishora', lat: 42.704, lng: 23.327, name: 'Banishora / Opalchenska', city: 'Sofia', country: 'Bulgaria', feed_url: 'https://meteo.chavo.biz/Camera_streem/live_snap.jpg', source: 'meteo.chavo.biz' },
    { id: 'bg-burgas-center', lat: 42.497, lng: 27.47, name: 'Burgas Center (Smart Burgas HLS)', city: 'Burgas', country: 'Bulgaria', stream_url: 'https://pics.smartburgas.eu/m3u8/burgas_town_Center.m3u8', stream_type: 'hls', external_url: 'https://www.weather-webcam.eu/cams/burgas-centar.html', source: 'Smart Burgas' },
  ];
  // BULGARIA_FWCBG_CAMERAS is empty in OSIRIS (generated file).
  return dedupeByKey(BULGARIA_MANUAL);
}

async function fetchGreeceCameras() {
  const ATTiki_ODOS_CAMERAS = [
    { alias: 'cam128', name: 'I/C D. Plakentias', city: 'Athens', lat: 38.0208, lng: 23.8578 },
    { alias: 'cam231', name: 'I/C Papagou', city: 'Athens', lat: 37.9906, lng: 23.7947 },
  ];
  return ATTiki_ODOS_CAMERAS.map((cam) => ({
    id: `gr-aodos-${cam.alias}`,
    lat: cam.lat, lng: cam.lng,
    name: cam.name, city: cam.city, country: 'Greece',
    stream_url: `https://ipcamlive.com/player/player.php?alias=${cam.alias}&autoplay=1`,
    stream_type: 'iframe',
    feed_url: `https://ipcamlive.com/player/player.php?alias=${cam.alias}&autoplay=1`,
    source: 'Attiki Odos',
  }));
}

async function fetchSerbiaCameras() {
  const SERBIA_CAMERAS = [
    { id: 'rs-belgrade-live', lat: 44.817, lng: 20.456, name: 'Belgrade Live Cam', city: 'Belgrade', country: 'Serbia', feed_url: 'https://stream.uzivobeograd.rs/live/cam_7.jpg', source: 'Uzivo Beograd' },
    { id: 'rs-kalotina-gradina-1', lat: 42.997, lng: 22.882, name: 'Kalotina – Gradina Border (lane 1)', city: 'Gradina', country: 'Serbia', stream_url: 'https://kamere.amss.org.rs/gradina1/gradina1.m3u8', stream_type: 'hls', source: 'AMSS / GKPP' },
  ];
  return SERBIA_CAMERAS.filter((cam) => cam.feed_url || cam.stream_url || cam.external_url);
}

async function fetchMacedoniaCameras() {
  const MACEDONIA_CAMERAS = [
    { id: 'mk-deve-bair', lat: 42.149, lng: 22.537, name: 'Deve Bair – Gyueshevo Border', city: 'Deve Bair', country: 'North Macedonia', stream_url: 'https://streaming1.neotel.net.mk/stream/deve_bair.m3u8', stream_type: 'hls', source: 'Neotel / GKPP' },
    { id: 'mk-tabanovce', lat: 42.232, lng: 21.718, name: 'Tabanovce – Preševo Border', city: 'Tabanovce', country: 'North Macedonia', stream_url: 'https://streaming1.neotel.net.mk/stream/tabanovce.m3u8', stream_type: 'hls', source: 'Neotel / GKPP' },
  ];
  return MACEDONIA_CAMERAS.filter((cam) => cam.feed_url || cam.stream_url || cam.external_url);
}

async function fetchTurkeyCameras() {
  return []; // TURKEY_CAMERAS is empty in OSIRIS
}

async function fetchRomaniaCameras() {
  const ROMANIA_CAMERAS = [
    { id: 'ro-bucharest', lat: 44.426, lng: 26.102, name: 'Bucharest Panorama', city: 'Bucharest', country: 'Romania', feed_url: 'https://home-solutions.bg/cams/bukor.jpg', source: 'home-solutions.bg' },
  ];
  return ROMANIA_CAMERAS.filter((cam) => cam.feed_url || cam.stream_url || cam.external_url);
}

async function fetchItalyCameras() {
  return [
    { id: 'it-rome-1', lat: 41.8902, lng: 12.4922, name: 'Rome - Colosseum Area', city: 'Rome', country: 'Italy', stream_url: 'https://www.youtube.com/embed/89d3tEaqImM?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'it-milan-1', lat: 45.4642, lng: 9.1900, name: 'Milan - Duomo Area', city: 'Milan', country: 'Italy', stream_url: 'https://www.youtube.com/embed/dsoM6TYIkOI?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'it-venice-1', lat: 45.4343, lng: 12.3388, name: 'Venice - Grand Canal', city: 'Venice', country: 'Italy', stream_url: 'https://www.youtube.com/embed/mt7uE-n0YPI?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'it-naples-1', lat: 40.8518, lng: 14.2681, name: 'Naples - City View', city: 'Naples', country: 'Italy', stream_url: 'https://www.youtube.com/embed/LO2Fvujwc8M?autoplay=1&mute=1', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchCzechiaCameras() {
  return [
    { id: 'cz-prague-1', lat: 50.0878, lng: 14.4205, name: 'Prague - Old Town Square', city: 'Prague', country: 'Czechia', stream_url: 'https://www.youtube.com/embed/IFnbDmgP69Q?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'cz-prague-2', lat: 50.0865, lng: 14.4114, name: 'Prague - Charles Bridge', city: 'Prague', country: 'Czechia', stream_url: 'https://www.youtube.com/embed/tmlE1ct0cYk?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'cz-prague-3', lat: 50.0900, lng: 14.4000, name: 'Prague - City View', city: 'Prague', country: 'Czechia', stream_url: 'https://www.youtube.com/embed/sspBOJIrNzU?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchSlovakiaCameras() {
  return [
    { id: 'sk-bratislava-1', lat: 48.1486, lng: 17.1077, name: 'Bratislava - Old Town', city: 'Bratislava', country: 'Slovakia', stream_url: 'https://www.youtube.com/embed/kYDIwCLGKL0?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'sk-bratislava-3', lat: 48.1450, lng: 17.1000, name: 'Bratislava - Danube River', city: 'Bratislava', country: 'Slovakia', stream_url: 'https://www.youtube.com/embed/xFdvZ4eGzPg?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchGermanyCameras() {
  return [
    { id: 'de-berlin-1', lat: 52.5200, lng: 13.4050, name: 'Berlin - Alexanderplatz', city: 'Berlin', country: 'Germany', stream_url: 'https://www.youtube.com/embed/IRqboacDNFg?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'de-munich-1', lat: 48.1351, lng: 11.5820, name: 'Munich - Marienplatz', city: 'Munich', country: 'Germany', stream_url: 'https://www.youtube.com/embed/KxWuwC7R5kY?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchFranceCameras() {
  return [
    { id: 'fr-paris-1', lat: 48.8584, lng: 2.2945, name: 'Paris - Eiffel Tower Area', city: 'Paris', country: 'France', stream_url: 'https://www.youtube.com/embed/UMuEooW0iAQ?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'fr-paris-2', lat: 48.8600, lng: 2.3300, name: 'Paris - Louvre Area', city: 'Paris', country: 'France', stream_url: 'https://www.youtube.com/embed/OzYp4NRZlwQ?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'fr-nice-1', lat: 43.6961, lng: 7.2717, name: 'Nice - Promenade des Anglais', city: 'Nice', country: 'France', stream_url: 'https://www.youtube.com/embed/YAdNYoRY0Cw?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'fr-nice-2', lat: 43.7000, lng: 7.2600, name: 'Nice - City View', city: 'Nice', country: 'France', stream_url: 'https://www.youtube.com/embed/asO_10T0k2k?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchSpainCameras() {
  return [
    { id: 'es-barcelona-2', lat: 41.3800, lng: 2.1800, name: 'Barcelona - Beach Area', city: 'Barcelona', country: 'Spain', stream_url: 'https://www.youtube.com/embed/4DjwrvoTKwk?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'es-madrid-1', lat: 40.4168, lng: -3.7038, name: 'Madrid - Puerta del Sol', city: 'Madrid', country: 'Spain', stream_url: 'https://www.youtube.com/embed/4CaHlfpGlAI?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
    { id: 'es-madrid-2', lat: 40.4200, lng: -3.7000, name: 'Madrid - Gran Via', city: 'Madrid', country: 'Spain', stream_url: 'https://www.youtube.com/embed/LSPN10FbR3U?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchPolandCameras() {
  return [
    { id: 'pl-gdansk-1', lat: 54.3520, lng: 18.6466, name: 'Gdansk - City View', city: 'Gdansk', country: 'Poland', stream_url: 'https://www.youtube.com/embed/NZ_ZiHAx8Ic?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0', stream_type: 'iframe', source: 'YouTube Live' },
  ];
}

async function fetchJapanCameras() {
  return [
    { id: 'jp-shibuya-crossing', lat: 35.6595, lng: 139.7005, name: 'Shibuya Scramble Crossing', city: 'Tokyo', country: 'Japan', stream_url: 'https://www.youtube.com/embed/HpdO5Kq3o7Y?autoplay=1&mute=1', stream_type: 'iframe', source: 'ANN News / YouTube' },
    { id: 'jp-tokyo-tower', lat: 35.6586, lng: 139.7454, name: 'Tokyo Tower Live Cam', city: 'Tokyo', country: 'Japan', stream_url: 'https://www.youtube.com/embed/cbJ03Xk_eLQ?autoplay=1&mute=1', stream_type: 'iframe', source: 'YouTube' },
    { id: 'jp-mt-fuji', lat: 35.3606, lng: 138.7274, name: 'Mt. Fuji Live', city: 'Shizuoka/Yamanashi', country: 'Japan', stream_url: 'https://www.youtube.com/embed/5aLh8R2HqOQ?autoplay=1&mute=1', stream_type: 'iframe', source: 'YouTube' },
    { id: 'jp-osaka-dotonbori', lat: 34.6687, lng: 135.5013, name: 'Dotonbori Live Cam', city: 'Osaka', country: 'Japan', stream_url: 'https://www.youtube.com/embed/m6J9w94oBXY?autoplay=1&mute=1', stream_type: 'iframe', source: 'YouTube' },
  ];
}

// ═══ REGION MAPPING (ported verbatim from route.ts) ═══
const REGION_FETCHERS = {
  'middle-east': fetchMiddleEastCameras,
  'uk': fetchTfLCameras,
  'us-west': async () => [...await fetchWSDOTCameras(), ...await fetchCaltransCameras()],
  'us-east': fetchUSEastCameras,
  'us-central': fetchUSCentralCameras,
  'canada': fetchCanadaCameras,
  'europe': fetchEuropeCameras,
  'asia': fetchAsiaCameras,
  'bulgaria': fetchBulgariaCameras,
  'greece': fetchGreeceCameras,
  'serbia': fetchSerbiaCameras,
  'macedonia': fetchMacedoniaCameras,
  'turkey': fetchTurkeyCameras,
  'romania': fetchRomaniaCameras,
  'australia': fetchAustraliaCameras,
  'italy': fetchItalyCameras,
  'czechia': fetchCzechiaCameras,
  'slovakia': fetchSlovakiaCameras,
  'germany': fetchGermanyCameras,
  'france': fetchFranceCameras,
  'spain': fetchSpainCameras,
  'poland': fetchPolandCameras,
  'japan': fetchJapanCameras,
};

// Determine which regions to fetch based on viewport bounds (verbatim).
export function getRegionsForBounds(lat, lng /*, radius */) {
  const regions = [];
  if (lat > 49 && lat < 61 && lng > -8 && lng < 2) regions.push('uk');
  if (lat > 24 && lat < 49 && lng > -85 && lng < -66) regions.push('us-east');
  if (lat > 24 && lat < 49 && lng > -125 && lng < -100) regions.push('us-west');
  if (lat > 24 && lat < 49 && lng > -105 && lng < -80) regions.push('us-central');
  if (lat > 42 && lat < 70 && lng > -141 && lng < -52) regions.push('canada');
  const inBulgaria = lat > 41 && lat < 44.5 && lng > 22 && lng < 29.5;
  const inGreece = lat > 34.5 && lat < 41.8 && lng > 19 && lng < 30;
  const inSerbia = lat > 42 && lat < 46.5 && lng > 18.8 && lng < 23.3;
  const inMacedonia = lat > 40.8 && lat < 42.8 && lng > 20.4 && lng < 23.2;
  const inRomania = lat > 43.5 && lat < 48.5 && lng > 20 && lng < 29.8;
  const inTurkey = lat > 35.5 && lat < 42.5 && lng > 25.5 && lng < 45;
  const inItaly = lat > 36 && lat < 47.5 && lng > 6.5 && lng < 18.5;
  const inCzechia = lat > 48.5 && lat < 51.1 && lng > 12 && lng < 18.9;
  const inSlovakia = lat > 47.7 && lat < 49.6 && lng > 16.8 && lng < 22.6;
  const inGermany = lat > 47 && lat < 55.1 && lng > 5.8 && lng < 15.1;
  const inFrance = lat > 42.3 && lat < 51.1 && lng > -5 && lng < 8.3;
  const inSpain = lat > 27 && lat < 43.8 && lng > -18.2 && lng < 4.4;
  const inPoland = lat > 49.0 && lat < 54.8 && lng > 14.1 && lng < 24.1;
  const inBalkans = inBulgaria || inGreece || inSerbia || inMacedonia || inRomania || inTurkey;
  const inWesternEurope = inItaly || inCzechia || inSlovakia || inGermany || inFrance || inSpain || inPoland;

  if (lat > 35 && lat < 72 && lng > -11 && lng < 40 && !inBalkans && !inWesternEurope) {
    regions.push('europe');
  }
  if (inBulgaria) regions.push('bulgaria');
  if (inGreece) regions.push('greece');
  if (inSerbia) regions.push('serbia');
  if (inMacedonia) regions.push('macedonia');
  if (inRomania) regions.push('romania');
  if (inTurkey) regions.push('turkey');
  if (inItaly) regions.push('italy');
  if (inCzechia) regions.push('czechia');
  if (inSlovakia) regions.push('slovakia');
  if (inGermany) regions.push('germany');
  if (inFrance) regions.push('france');
  if (inSpain) regions.push('spain');
  if (inPoland) regions.push('poland');

  const inMiddleEast = lat > 29 && lat < 34.5 && lng > 34 && lng < 36.5;
  if (inMiddleEast) regions.push('middle-east');

  if (lat > 24 && lat < 46 && lng > 122 && lng < 154) regions.push('japan');
  if ((lat > -10 && lat < 60 && lng > 60 && lng < 150)) regions.push('asia');
  if (lat > -45 && lat < -10 && lng > 110 && lng < 155) regions.push('asia');

  return regions.length > 0 ? regions : ['uk', 'us-east'];
}

/**
 * Assemble cameras for the given regions. Mirrors OSIRIS's GET handler
 * region resolution. Returns { cameras, sources, regions }.
 */
export async function fetchCamerasForRegions(opts = {}) {
  const { region, lat = 0, lng = 0, radius = 10 } = opts;
  let regionsToFetch;
  if (region === 'all') {
    regionsToFetch = Object.keys(REGION_FETCHERS);
  } else if (region) {
    regionsToFetch = String(region).split(',').filter((r) => r in REGION_FETCHERS);
  } else if (lat !== 0 || lng !== 0) {
    regionsToFetch = getRegionsForBounds(lat, lng, radius);
  } else {
    regionsToFetch = Object.keys(REGION_FETCHERS);
  }

  const results = await Promise.allSettled(regionsToFetch.map((r) => REGION_FETCHERS[r]()));

  const cameras = [];
  const sources = {};
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const cam of result.value) {
        cameras.push(cam);
        sources[cam.source] = (sources[cam.source] || 0) + 1;
      }
    }
  }
  return { cameras, sources, regions: regionsToFetch };
}

/**
 * Cap the assembled set to `max`, round-robin by source so the global spread
 * is preserved and only the long tail of bulky sources is dropped. Returns
 * { cameras, sources } recomputed from the capped list.
 */
function capCameras(cameras, max) {
  if (cameras.length <= max) {
    const sources = {};
    for (const c of cameras) sources[c.source] = (sources[c.source] || 0) + 1;
    return { cameras, sources };
  }
  const bySource = new Map();
  for (const c of cameras) {
    const k = c.source || '?';
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(c);
  }
  const buckets = [...bySource.values()];
  const out = [];
  for (let i = 0; out.length < max; i++) {
    let added = false;
    for (const b of buckets) {
      if (i < b.length) {
        out.push(b[i]);
        added = true;
        if (out.length >= max) break;
      }
    }
    if (!added) break; // all buckets exhausted
  }
  const sources = {};
  for (const c of out) sources[c.source] = (sources[c.source] || 0) + 1;
  return { cameras: out, sources };
}

// ═══ 12h assembled-list cache for the global set ═══
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let allCache = null;       // { fetchedAt, cameras, sources }
let allInflight = null;

/**
 * Return the full assembled camera set (all regions). Cached 12h with
 * single-flight; stale cache is served if a refresh fails.
 */
export async function getAllCameras() {
  if (allCache && Date.now() - allCache.fetchedAt < CACHE_TTL_MS) return allCache;
  if (allInflight) return allInflight;

  allInflight = (async () => {
    try {
      const assembled = await fetchCamerasForRegions({ region: 'all' });
      // If we got almost nothing (all upstreams down), keep any prior snapshot.
      if (assembled.cameras.length < 50 && allCache) return allCache;
      // Cap to MAX_CAMERAS, preserving a global spread across sources.
      const { cameras, sources } = capCameras(assembled.cameras, MAX_CAMERAS);
      const loaded = { fetchedAt: Date.now(), cameras, sources };
      allCache = loaded;
      return loaded;
    } catch (e) {
      if (allCache) return allCache;
      throw e;
    } finally {
      allInflight = null;
    }
  })();

  return allInflight;
}

/** Resolve a single camera by id from the cached set (for the snapshot proxy). */
export async function getCameraById(id) {
  const { cameras } = await getAllCameras();
  return cameras.find((c) => c.id === id) || null;
}
