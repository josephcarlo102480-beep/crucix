// CelesTrak host gate — stubbed fetch and clock, no network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cacheDir = mkdtempSync(join(tmpdir(), 'crucix-tle-gate-'));
process.env.CRUCIX_TLE_CACHE_DIR = cacheDir;

const HOUR = 3600e3;
const realNow = Date.now;
const realFetch = globalThis.fetch;
const start = realNow();
let offset = 0;
Date.now = () => start + offset;

function tleEpoch(ms) {
  const date = new Date(ms);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = 1 + (ms - yearStart) / 86400000;
  return `${String(date.getUTCFullYear() % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
}

function tleText(id, name) {
  const catalog = String(id).padStart(5, '0');
  return [
    name,
    `1 ${catalog}U 98067A   ${tleEpoch(start)}  .00000000  00000-0  00000-0 0  9999`,
    `2 ${catalog}  51.6400 100.0000 0005000 100.0000 260.0000 15.50000000123456`,
  ].join('\n');
}

let mode = 'ok';
const calls = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  if (!href.startsWith('https://celestrak.org/')) throw new Error(`unexpected host: ${href}`);
  calls.push(new URL(href).searchParams.get('GROUP') || new URL(href).searchParams.get('FILE'));
  if (mode === 'down') throw new TypeError('fetch failed');
  if (mode === 'notmod') return new Response('GP data has not updated since your last successful download', { status: 403 });
  if (mode === '500') return new Response('Internal Server Error', { status: 500 });
  return new Response(tleText(25544, 'ISS (ZARYA)'));
};

const { celestrakGate, getGroup } = await import('../services/space/tleCatalog.mjs');
const gateOnDisk = () => JSON.parse(readFileSync(join(cacheDir, '_celestrak-gate.json'), 'utf8'));
const take = () => calls.splice(0);

after(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  delete process.env.CRUCIX_TLE_CACHE_DIR;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('CelesTrak host gate', () => {
  test('one failure pauses every group, cached or not, for 2 h', async () => {
    mode = 'ok';
    await getGroup('stations');
    assert.deepEqual(take(), ['stations']);

    offset = 3 * HOUR; // stations is past its TTL
    mode = 'down';
    const held = await getGroup('stations');
    assert.equal(held.stale, true, 'cached copy is served through the failure');
    assert.deepEqual(take(), ['stations']);
    assert.equal(gateOnDisk().failures, 1);
    assert.ok(Math.abs(gateOnDisk().pausedUntil - (start + 5 * HOUR)) < 1000);

    // A different, never-cached group is refused without touching the network.
    await assert.rejects(getGroup('visual'), /CelesTrak paused until/);
    // The cached group keeps answering, also without the network.
    assert.equal((await getGroup('stations')).stale, true);
    assert.deepEqual(take(), []);
  });

  test('parallel failures count once, and the pause escalates 2 → 4 h', async () => {
    offset = 5 * HOUR + 1000; // pause over
    await Promise.all([getGroup('stations'), getGroup('visual').catch(() => {})]);
    assert.equal(take().length, 2, 'both groups tried once when the pause ended');
    assert.equal(gateOnDisk().failures, 2, 'two parallel failures are one escalation step');
    assert.ok(Math.abs(gateOnDisk().pausedUntil - (start + 9 * HOUR + 1000)) < 1000);

    offset = 9 * HOUR; // still inside the 4 h pause
    await getGroup('stations');
    assert.deepEqual(take(), []);
  });

  test('HTTP errors trip the gate; CelesTrak answering at all clears it', async () => {
    offset = 9 * HOUR + 2000;
    mode = '500';
    await getGroup('stations');
    assert.equal(take().length, 1);
    assert.equal(gateOnDisk().failures, 3);

    offset = 17 * HOUR + 3000; // past the 8 h pause
    mode = 'notmod';
    await getGroup('stations');
    assert.equal(take().length, 1);
    assert.equal(celestrakGate.pausedUntil(), 0);
    assert.equal(gateOnDisk().failures, 0);

    // Not-modified holds the group for 2 h, not 30 min.
    offset = 18 * HOUR + 3000;
    await getGroup('stations');
    assert.deepEqual(take(), []);
    offset = 19 * HOUR + 4000;
    mode = 'ok';
    await getGroup('stations');
    assert.deepEqual(take(), ['stations']);
  });

  test('the shared active catalogue is held 12 h, other groups 2.5 h', async () => {
    mode = 'ok';
    offset = 20 * HOUR;
    await getGroup('military');
    assert.deepEqual(take().sort(), ['active', 'military']);

    offset = 23 * HOUR; // military's 2.5 h TTL has passed, active's 12 h has not
    await getGroup('military');
    assert.deepEqual(take(), ['military']);

    offset = 32 * HOUR + 1000;
    await getGroup('military');
    assert.deepEqual(take().sort(), ['active', 'military']);
  });
});

describe('recent-launch pull honours the gate', () => {
  test('a paused gate skips the fetch; a failure trips it; not-modified waits 2 h', async () => {
    const { briefing, clearRecentLaunchCache } = await import('../apis/sources/space.mjs');
    const stubGroups = async () => ({ sats: [], total: 0 });
    let paused = true;
    let failures = 0;
    let fetches = 0;
    const gate = { pausedUntil: () => (paused ? Date.now() + HOUR : 0), failure: () => { failures += 1; }, success: () => {} };

    clearRecentLaunchCache();
    const skipped = await briefing({ loadGroup: stubGroups, gate, fetchImpl: async () => { fetches += 1; return []; } });
    assert.equal(fetches, 0);
    assert.match(skipped.error, /CelesTrak paused until/);

    paused = false;
    clearRecentLaunchCache();
    await briefing({ loadGroup: stubGroups, gate, fetchImpl: async () => { fetches += 1; return { error: 'fetch failed' }; } });
    assert.equal(fetches, 1);
    assert.equal(failures, 1);

    clearRecentLaunchCache();
    await briefing({ loadGroup: stubGroups, gate, fetchImpl: async () => ({ error: 'HTTP 403: GP data has not updated since your last successful download' }) });
    assert.equal(failures, 1, 'not-modified is not a failure');
    offset += HOUR;
    await briefing({ loadGroup: stubGroups, gate, fetchImpl: async () => { fetches += 1; return []; } });
    assert.equal(fetches, 1, 'still inside the 2 h not-modified hold');
  });
});
