import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStates } from '../apis/sources/opensky.mjs';
import { briefing as bluesky } from '../apis/sources/bluesky.mjs';
import { briefing as patents, searchPatents, searchByAssignee } from '../apis/sources/patents.mjs';
import { briefing as safecast } from '../apis/sources/safecast.mjs';
import { synthesize } from '../dashboard/inject.mjs';

test('OpenSky distinguishes successful empty observations from broken responses', () => {
  for (const states of [null, []]) {
    const result = classifyStates({ time: 1788730626, states });
    assert.equal(result.status, 'no_data');
    assert.equal(result.error, undefined);
    assert.match(result.message, /does not establish an empty sky/);
  }
  assert.equal(classifyStates({ states: [['abc123']] }).status, 'healthy');
  for (const data of [null, {}, { states: null }, { states: 'bad' }, { error: 'HTTP 429' }]) {
    assert.equal(classifyStates(data).status, 'failed');
  }
});

test('Bluesky searches the working AppView and retains real upstream failures', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(new URL(url));
    return urls.length === 2
      ? new Response('Unavailable', { status: 503 })
      : Response.json({ posts: [{ record: { text: 'sample', createdAt: '2026-09-06T21:00:00Z' }, author: { handle: 'example.test' } }] });
  });
  const result = await bluesky();
  assert.equal(urls.length, 3);
  assert.ok(urls.every(u => u.origin === 'https://api.bsky.app'));
  assert.equal(result.topics.conflict.length, 1);
  assert.equal(result.topics.health.length, 1);
  assert.deepEqual(result.topics.markets, []);
  assert.match(result.error, /1\/3 topics/);
});

test('Patents reports unavailable without network retries or a false zero count', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('retired endpoint must not be called'); });
  const result = await patents();
  assert.equal(result.status, 'failed');
  assert.equal(result.totalFound, null);
  assert.deepEqual(result.signals, []);
  assert.match(result.error, /supported replacement/);
  assert.ok((await searchPatents('AI')).error);
  assert.ok((await searchByAssignee('Example')).error);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('Safecast makes one request to the real-time device feed', async t => {
  const now = Date.parse('2026-09-06T21:00:00Z');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(new URL(url));
    return Response.json([]);
  });
  const result = await safecast({ now });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].origin + urls[0].pathname, 'https://tt.safecast.org/devices');
  assert.equal([...urls[0].searchParams].length, 0);
  assert.ok(result.sites.every(s => s.anomaly === null));
  assert.deepEqual(result.signals, []);
});

test('dashboard preserves per-region observation gaps and request failures', async () => {
  const result = await synthesize({
    crucix: { timestamp: '2026-09-06T21:00:00Z' }, errors: [],
    sources: { OpenSky: { hotspots: [
      { region: 'A', totalAircraft: 2, status: 'healthy' },
      { region: 'B', totalAircraft: 0, ...classifyStates({ time: 1788730626, states: null }) },
      { region: 'C', totalAircraft: 0, ...classifyStates({ error: 'HTTP 429' }) },
    ] } },
  }, { newsLoader: async () => [] });
  assert.equal(result.air[1].status, 'no_data');
  assert.match(result.air[1].observationNote, /does not establish an empty sky/);
  assert.equal(result.air[2].status, 'failed');
  assert.equal(result.air[2].observationNote, 'HTTP 429');
});
