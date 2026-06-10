/**
 * GeoNames-backed multilingual geoparser (Module A, Component 2).
 *
 * Built from scratch. Resolves place mentions in short Telegram posts to
 * coordinates using the GeoNames `cities15000` gazetteer (~25k cities, with
 * a multilingual `alternatenames` column covering Cyrillic, Arabic, etc.).
 *
 * ── HONEST CONSTRAINT ──────────────────────────────────────────────────
 * Geoparsing short social text is inherently noisy: homonyms (Nice/Mobile/
 * Reading), datelines that aren't the event location, sarcasm, and partial
 * names. This is a LEAD-PLOTTING AID, not authoritative geolocation. Every
 * match carries a confidence score; the frontend defaults to showing only
 * matches at or above a tunable threshold. Treat pins as "worth a look,"
 * not ground truth.
 * ───────────────────────────────────────────────────────────────────────
 *
 * The gazetteer is downloaded once (cities15000.zip), extracted in pure Node
 * (no unzip binary), and the .txt is cached to disk so subsequent boots skip
 * the download. If geonames.org is unreachable, set GEONAMES_FILE to a
 * manually-downloaded cities15000.txt — see TODO(G) below.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { inflateRawSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const TXT_CACHE = join(DATA_DIR, 'geonames-cities15000.txt');

const GEONAMES_ZIP_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const ZIP_ENTRY_NAME = 'cities15000.txt';

// ── Tunables ──────────────────────────────────────────────────────────
// Require Latin-script matches to be capitalized in the source text. Kills
// a huge class of false positives ("nice", "reading", "of") while keeping
// real proper-noun mentions. Non-Latin scripts (no case) are exempt.
const REQUIRE_CAPITALIZED_LATIN = true;
// Longest place name (in words) we try to match, e.g. "United Arab Emirates".
const MAX_NGRAM_WORDS = 4;
// Single-word matches shorter than this are ignored in any script — kills
// 2-letter prepositions ("of", "по", "في") that collide with tiny towns.
const MIN_SINGLE_WORD_LEN = 3;

/**
 * Place names that collide with common words. Extend freely. These are
 * dropped even when capitalized (sentence starts, headlines). Kept lowercase.
 */
export const STOPLIST = new Set([
  // grammatical / ultra-common
  'a', 'i', 'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'he', 'she',
  'we', 'us', 'me', 'my', 'no', 'not', 'so', 'up', 'do', 'go', 'if', 'for',
  // verbs / nouns that are also GeoNames towns
  'same', 'why', 'split', 'most', 'both', 'will', 'can', 'may', 'deal',
  'sale', 'bath', 'eye', 'hull', 'reading', 'mobile', 'nice', 'march',
  'august', 'best', 'general', 'born', 'die', 'good', 'hope', 'home',
  'man', 'men', 'state', 'union', 'central', 'industry', 'progress',
  'liberty', 'eight', 'two', 'three', 'four', 'five', 'six', 'seven',
  // Russian / Ukrainian function words (no case to lean on in Cyrillic)
  'в', 'и', 'на', 'по', 'под', 'за', 'от', 'до', 'не', 'что', 'как', 'это',
  'для', 'без', 'со', 'об', 'или', 'но', 'да', 'же', 'то', 'его', 'она',
  'они', 'мы', 'вы', 'из', 'у', 'к', 'с', 'о', 'а', 'та', 'він', 'це', 'над',
  // Arabic function words
  'في', 'من', 'الى', 'إلى', 'على', 'عن', 'مع', 'لا', 'ما', 'هذا', 'هذه',
  'ان', 'أن', 'التي', 'الذي', 'و', 'ثم', 'قد',
  // Media outlets that collide with gazetteer entries. Seen live: "CNN" is an
  // alternate name of Kannur, India (airport code), and "Al-Mayadeen
  // correspondent" pinned the Syrian city Al Mayādīn. In news text these are
  // almost always the outlet, not the place. Hyphenated forms are single
  // tokens (tokenizer keeps '-'), so list both variants.
  'cnn', 'bbc', 'tass', 'reuters', 'sputnik', 'afp', 'dpa',
  'al-mayadeen', 'al mayadeen', 'mayadeen',
  'al-jazeera', 'al jazeera', 'al-arabiya', 'al arabiya',
  'al-masirah', 'al masirah', 'sky news', 'fox news',
]);

let index = null;       // Map<normKey, candidate[]>
let entryCount = 0;     // number of indexed keys
let cityCount = 0;      // number of source cities
let loading = null;     // in-flight load promise

// ── pure-Node single-file ZIP extraction (deflate) ──────────────────────
function extractZipEntry(buf, wantName) {
  // Locate End Of Central Directory record (sig 0x06054b50) from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: EOCD not found');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('ZIP: bad CD header');
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);

    if (name === wantName) {
      // Jump to the local header to find where the data actually starts.
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP: bad local header');
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return comp;            // stored
      if (method === 8) return inflateRawSync(comp); // deflate
      throw new Error(`ZIP: unsupported method ${method}`);
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP: entry ${wantName} not found`);
}

// ── normalization ───────────────────────────────────────────────────────
/** Lowercase + collapse whitespace + strip edge punctuation. toLowerCase()
 *  also folds Cyrillic case, which is what we want; Arabic has no case. */
function normKey(s) {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.'-]+/, '')   // strip leading punctuation
    .replace(/[.'-]+$/, '');  // strip trailing punctuation (e.g. "Donetsk.")
}

// A name worth indexing as an alternate: has a letter, not absurdly long,
// not a URL/code fragment.
function indexableName(s) {
  if (!s || s.length < 2 || s.length > 40) return false;
  if (/[\/\\@]|https?:/i.test(s)) return false;
  if (!/\p{L}/u.test(s)) return false;
  return true;
}

const LATIN_RE = /^[\p{Script=Latin}\p{M}\p{N}\s'.-]+$/u;
function isLatin(s) { return LATIN_RE.test(s); }

// ── gazetteer parse + index build ────────────────────────────────────────
function buildIndex(txt) {
  const map = new Map();
  let cities = 0;
  const lines = txt.split('\n');
  for (const line of lines) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 15) continue;
    const name = c[1];
    const asciiname = c[2];
    const alt = c[3];
    const lat = parseFloat(c[4]);
    const lon = parseFloat(c[5]);
    const population = parseInt(c[14], 10) || 0;
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    cities++;

    const candidate = { lat, lon, population, canonical: name };

    const names = new Set();
    names.add(name);
    if (asciiname) names.add(asciiname);
    if (alt) for (const a of alt.split(',')) { const t = a.trim(); if (indexableName(t)) names.add(t); }

    for (const nm of names) {
      const key = normKey(nm);
      if (!key || key.length < 2) continue;
      const list = map.get(key);
      if (list) list.push(candidate);
      else map.set(key, [candidate]);
    }
  }
  // Sort each key's candidates by population desc so [0] is the best guess.
  for (const list of map.values()) list.sort((a, b) => b.population - a.population);
  index = map;
  entryCount = map.size;
  cityCount = cities;
}

async function downloadAndCache() {
  const res = await fetch(GEONAMES_ZIP_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (CrucixOSINT)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`GeoNames HTTP ${res.status}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const txtBuf = extractZipEntry(zipBuf, ZIP_ENTRY_NAME);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TXT_CACHE, txtBuf);
  return txtBuf.toString('utf8');
}

/**
 * Load the gazetteer and build the index. Idempotent + single-flight.
 * Resolution order: GEONAMES_FILE env → disk cache → download.
 */
export async function loadGazetteer() {
  if (index) return true;
  if (loading) return loading;

  loading = (async () => {
    try {
      let txt;
      const envFile = process.env.GEONAMES_FILE;
      if (envFile && existsSync(envFile)) {
        txt = readFileSync(envFile, 'utf8');
      } else if (existsSync(TXT_CACHE)) {
        txt = readFileSync(TXT_CACHE, 'utf8');
      } else {
        // TODO(G): if geonames.org is blocked on the Pi's network, manually
        // download https://download.geonames.org/export/dump/cities15000.zip,
        // unzip it, and either drop cities15000.txt at
        //   <repo>/data/geonames-cities15000.txt
        // or set GEONAMES_FILE=/path/to/cities15000.txt and restart.
        txt = await downloadAndCache();
      }
      buildIndex(txt);
      console.log(`[telegram] gazetteer ready: ${cityCount} cities, ${entryCount} indexed names`);
      return true;
    } catch (e) {
      console.warn(`[telegram] gazetteer load failed: ${e?.message || e}`);
      console.warn('[telegram] TODO(G): geoparse stays in "loading" until cities15000.txt is available (see GEONAMES_FILE).');
      return false;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

export function isReady() { return index !== null; }
export function gazetteerSize() { return entryCount; }
export function cityTotal() { return cityCount; }

// ── matching ──────────────────────────────────────────────────────────
// Tokenize into words, keeping original text (for capitalization) + offset.
function tokenize(text) {
  const tokens = [];
  const re = /[\p{L}\p{M}][\p{L}\p{M}'.\-]*/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ raw: m[0], norm: normKey(m[0]), latin: isLatin(m[0]) });
  }
  return tokens;
}

function isCapitalized(raw) {
  const first = raw[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

function confidence({ candidate, nWords, capitalized, nonLatinScript }) {
  const popScore = Math.min(1, Math.log10(candidate.population + 1) / 7); // 10M→1, 15k→~0.6
  let c = 0.30;
  c += popScore * 0.40;
  if (nWords >= 2) c += 0.20;          // multi-word names are rarely accidental
  if (capitalized) c += 0.15;          // proper-noun signal (Latin)
  if (nonLatinScript) c += 0.15;       // Cyrillic/Arabic exact-script hit
  return Math.max(0, Math.min(1, c));
}

/**
 * Geoparse one text. Returns an array of matches (possibly empty):
 *   { place, lat, lon, confidence }
 * Longest-match-first, non-overlapping; ambiguous names resolve to the
 * highest-population candidate.
 */
export function geoparseText(text) {
  if (!index || !text) return [];
  const tokens = tokenize(text);
  const matches = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    const maxN = Math.min(MAX_NGRAM_WORDS, tokens.length - i);
    for (let n = maxN; n >= 1; n--) {
      const span = tokens.slice(i, i + n);
      const key = span.map((t) => t.norm).join(' ');
      if (!key || STOPLIST.has(key)) continue;
      if (n === 1 && key.length < MIN_SINGLE_WORD_LEN) continue;
      const candidates = index.get(key);
      if (!candidates) continue;

      const spanLatin = span.every((t) => t.latin);
      if (REQUIRE_CAPITALIZED_LATIN && spanLatin && !span.every((t) => isCapitalized(t.raw))) {
        continue; // Latin token(s) not capitalized — likely a common word
      }

      const candidate = candidates[0]; // highest population
      const conf = confidence({
        candidate,
        nWords: n,
        capitalized: spanLatin && span.every((t) => isCapitalized(t.raw)),
        nonLatinScript: !spanLatin,
      });
      matches.push({
        place: candidate.canonical,
        lat: candidate.lat,
        lon: candidate.lon,
        confidence: Math.round(conf * 100) / 100,
      });
      i += n;          // consume the matched span (longest-match-first)
      matched = true;
      break;
    }
    if (!matched) i++;
  }

  // De-dupe identical coordinates, keep the highest confidence per place.
  const best = new Map();
  for (const m of matches) {
    const k = `${m.lat},${m.lon}`;
    const prev = best.get(k);
    if (!prev || m.confidence > prev.confidence) best.set(k, m);
  }
  return [...best.values()];
}

/** Attach a `geo` array to each post (in place, returns the same array). */
export function geoparsePosts(posts) {
  for (const p of posts) p.geo = geoparseText(p.text);
  return posts;
}

/** Fire-and-forget boot warm for the gazetteer. */
export async function warmGazetteer() {
  return loadGazetteer();
}
