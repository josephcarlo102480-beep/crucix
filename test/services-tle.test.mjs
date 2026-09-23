import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cacheDir = mkdtempSync(join(tmpdir(), 'crucix-tle-'));
process.env.CRUCIX_TLE_CACHE_DIR = cacheDir;

// The catalogue drops elements older than 21 days, so the fixture epoch must
// track the clock rather than a fixed date.
function tleEpoch(ms = Date.now()) {
  const date = new Date(ms);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = 1 + (ms - yearStart) / 86400000;
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  return `${yy}${day.toFixed(8).padStart(12, '0')}`;
}

function sat(id, name = `SAT ${id}`) {
  const catalog = String(id).padStart(5, '0');
  return {
    id,
    name,
    line1: `1 ${catalog}U 98067A   ${tleEpoch()}  .00000000  00000-0  00000-0 0  9999`,
    line2: `2 ${catalog}  51.6400 100.0000 0005000 100.0000 260.0000 15.50000000123456`,
    epoch: Date.now(),
  };
}

function tleText(sats) {
  return sats.flatMap((item) => [item.name, item.line1, item.line2]).join('\n');
}

const heldDisk = {
  fetchedAt: Date.now(),
  checkedAt: 1,
  sats: [sat(25544, 'ISS (ZARYA)')],
  stale: true,
};
writeFileSync(join(cacheDir, 'stations.json'), JSON.stringify(heldDisk));

const visualSats = Array.from({ length: 201 }, (_, index) => sat(30000 + index));
const activeSats = [
  ...Array.from({ length: 8 }, (_, index) => sat(40000 + index, `DECOY 25544 ${index}`)),
  sat(25544, 'ISS (ZARYA)'),
];

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  calls.push(href);
  if (href.includes('GROUP=stations')) {
    return new Response('GP data has not updated since your last successful download', { status: 403 });
  }
  if (href.includes('GROUP=visual')) return new Response(tleText(visualSats));
  if (href.includes('GROUP=active')) return new Response(tleText(activeSats));
  if (href.includes('GROUP=weather')) return new Response(tleText([sat(50001, 'WEATHER ONE')]));
  if (href.includes('GROUP=resource')) throw new Error('resource source unavailable');
  throw new Error(`unexpected TLE fetch: ${href}`);
};

const catalog = await import('../services/space/tleCatalog.mjs');
const { default: tleRouter } = await import('../services/space/tleRouter.mjs');

after(() => {
  catalog.stopTleWarm();
  globalThis.fetch = realFetch;
  delete process.env.CRUCIX_TLE_CACHE_DIR;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('TLE cache and lookup', () => {
  test('not-modified keeps the cache file byte-for-byte untouched and clears stale', async () => {
    const path = join(cacheDir, 'stations.json');
    const beforeBytes = readFileSync(path);
    const beforeMtime = statSync(path).mtimeMs;

    const payload = await catalog.getGroup('stations');

    assert.equal(payload.stale, false);
    assert.deepEqual(readFileSync(path), beforeBytes);
    assert.equal(statSync(path).mtimeMs, beforeMtime);
  });

  test('fresh downloads are written as complete atomic JSON files', async () => {
    const payload = await catalog.getGroup('visual');
    assert.equal(payload.total, 201);

    const stored = JSON.parse(readFileSync(join(cacheDir, 'visual.json'), 'utf8'));
    assert.equal(stored.sats.length, 201);
    assert.equal(stored.stale, false);
    assert.equal(readdirSync(cacheDir).some((name) => name.includes('.tmp-')), false);
  });

  test('numeric search performs a direct NORAD lookup before its bounded scan', async () => {
    const result = await catalog.search('25544', 1);
    assert.equal(result.count, 1);
    assert.equal(result.sats[0].id, 25544);
  });

  test('partial group results report structured component failures', async () => {
    const result = await catalog.getGroup('weather');
    assert.equal(result.count, 1);
    assert.deepEqual(result.failures, [{ group: 'resource', error: 'resource source unavailable' }]);
  });
});

describe('TLE router limits', () => {
  test('limit=0 uses the group default instead of bypassing the 4000 ceiling', async () => {
    const layer = tleRouter.stack.find((item) => item.route?.path === '/:group');
    const response = { statusCode: 200, headers: {} };
    response.set = (key, value) => { response.headers[key] = value; return response; };
    response.status = (code) => { response.statusCode = code; return response; };
    response.json = (body) => { response.body = body; return response; };
    await layer.route.stack[0].handle(
      { params: { group: 'visual' }, query: { limit: '0' } },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.count, 200);
    assert.equal(response.body.total, 201);
  });
});
