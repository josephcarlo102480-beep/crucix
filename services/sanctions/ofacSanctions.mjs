/**
 * OFAC SDN sanctioned-entity lookup.
 *
 * Ported verbatim (logic-preserving) from OSIRIS `src/lib/sanctions.ts`.
 * Only the module wrapper changed (TS types stripped, ESM `.mjs`); the
 * fetch / CSV-parse / normalise / search logic is unchanged.
 *
 * Source: OpenSanctions `us_ofac_sdn` dataset, distributed as a simple CSV
 * under CC-BY 4.0. OpenSanctions normalises the upstream Treasury data into
 * a flat schema with stable field names and an entity-type discriminator
 * (`Person`, `Organization`, `Vessel`, `Airplane`, …).
 *
 * The whole list (~7 MB, low-tens-of-thousands of entries) is downloaded
 * once on first use, parsed into normalised lookup indices, and refreshed
 * lazily every 24h. Concurrent requests that arrive while a fetch is in
 * flight wait on the same promise (single-flight) so we never pull the file
 * twice. If a refresh fails after the cache has gone stale we keep serving
 * the previous snapshot rather than leaving the route blind.
 */

const SDN_CSV_URL =
  process.env.OPENSANCTIONS_SDN_URL ||
  'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/targets.simple.csv';

const TTL_MS = 24 * 60 * 60 * 1000;

let cache = null;       // { fetchedAt, entries, byNormName }
let inflight = null;    // Promise<LoadedList>

/**
 * Lower-case, strip punctuation, collapse whitespace. Used for both index
 * keys and incoming query normalisation so the same string yields the same
 * key on both sides.
 */
export function normName(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Minimal CSV parser tolerant of double-quoted fields with embedded commas,
 * newlines and `""` escapes. The OpenSanctions CSV is well-formed so we
 * don't need a heavyweight parser.
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore — handled by the \n branch
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function loadList() {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(SDN_CSV_URL, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'text/csv' },
      });
      if (!res.ok) throw new Error(`OpenSanctions HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error('OpenSanctions CSV empty');

      const headers = rows[0];
      const idx = (col) => headers.indexOf(col);
      const i = {
        id: idx('id'),
        schema: idx('schema'),
        name: idx('name'),
        aliases: idx('aliases'),
        countries: idx('countries'),
        programs: idx('program_ids'),
        sanctions: idx('sanctions'),
        first_seen: idx('first_seen'),
        last_seen: idx('last_seen'),
      };

      const entries = [];
      const byNormName = new Map();

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row[i.name]) continue;
        const entry = {
          id: row[i.id] || '',
          schema: row[i.schema] || 'LegalEntity',
          name: row[i.name],
          aliases: (row[i.aliases] || '').split(';').map((s) => s.trim()).filter(Boolean),
          countries: (row[i.countries] || '').split(';').map((s) => s.trim()).filter(Boolean),
          programs: (row[i.programs] || '').split(';').map((s) => s.trim()).filter(Boolean),
          sanctions: row[i.sanctions] || '',
          first_seen: i.first_seen >= 0 ? row[i.first_seen] : undefined,
          last_seen: i.last_seen >= 0 ? row[i.last_seen] : undefined,
        };
        entries.push(entry);

        // Index every name + alias under its normalised form so an exact
        // (post-normalisation) match is O(1).
        const keys = new Set([entry.name, ...entry.aliases].map(normName));
        for (const key of keys) {
          if (!key) continue;
          const list = byNormName.get(key);
          if (list) list.push(entry);
          else byNormName.set(key, [entry]);
        }
      }

      const loaded = { fetchedAt: Date.now(), entries, byNormName };
      cache = loaded;
      return loaded;
    } catch (e) {
      if (cache) return cache;
      throw e;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Substring + contains search. Returns up to `limit` matches, ranked: exact
 * name match first, then exact alias match, then substring of name, then
 * substring of alias.
 */
export async function search(query, opts = {}) {
  if (!query || query.length < 4) return [];
  const list = await loadList();
  const q = normName(query);
  const limit = opts.limit ?? 50;

  const exactName = [];
  const exactAlias = [];
  const subName = [];
  const subAlias = [];
  const seen = new Set();

  const push = (bucket, e) => {
    if (seen.has(e.id)) return;
    if (opts.schema && e.schema !== opts.schema) return;
    seen.add(e.id);
    bucket.push(e);
  };

  for (const entry of list.entries) {
    const nameNorm = normName(entry.name);
    if (nameNorm === q) push(exactName, entry);
    else if (entry.aliases.some((a) => normName(a) === q)) push(exactAlias, entry);
    else if (nameNorm.includes(q)) push(subName, entry);
    else if (entry.aliases.some((a) => normName(a).includes(q))) push(subAlias, entry);
    if (seen.size >= limit * 4) break; // hard cap on the scan
  }

  return [...exactName, ...exactAlias, ...subName, ...subAlias].slice(0, limit);
}

/**
 * RECON-style public entry point used by the Crucix router. Case-insensitive
 * full-text match across name/aliases (type-filterable via opts.schema).
 */
export async function searchSanctions(query, opts = {}) {
  return search(query, opts);
}

/** True once the SDN list has been downloaded and parsed at least once. */
export function isReady() {
  return cache !== null;
}

/** Number of indexed entries, for diagnostics. */
export function indexSize() {
  return cache ? cache.entries.length : 0;
}

/**
 * Warm the cache asynchronously on boot. Fire-and-forget friendly: resolves
 * to true on success, false on failure (so callers can log without throwing).
 */
export async function warmCache() {
  try {
    await loadList();
    return true;
  } catch {
    return false;
  }
}
