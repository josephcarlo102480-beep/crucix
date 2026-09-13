import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dashboard/public/js/live-updates.js', import.meta.url), 'utf8');
function harness(fetchImpl) {
  const sandbox = { AbortController };
  vm.runInNewContext(source, sandbox);
  const streams = [], applied = [], states = [], sweeps = [], errors = [], timers = new Map(), listeners = new Map();
  let id = 0, fetches = 0;
  class FakeStream {
    constructor() { this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen(); }
    message(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  const documentImpl = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const client = sandbox.CrucixLiveUpdates.createLiveUpdates({
    EventSourceImpl: FakeStream,
    fetchImpl: async (...args) => { fetches++; return fetchImpl(...args); },
    applySnapshot: data => applied.push(data),
    onState: state => states.push(state), onSweep: active => sweeps.push(active), onError: error => errors.push(error),
    schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, cancel: id => timers.delete(id), documentImpl,
  });
  function tick(ms) {
    for (const [key, t] of [...timers].filter(([, t]) => t.ms === ms)) { timers.delete(key); t.fn(); }
  }
  return { client, streams, applied, states, sweeps, errors, timers, listeners, tick, fetches: () => fetches };
}
const response = data => ({ ok: true, json: async () => data });

test('reconnection fetches missed data and only schedules one reconnect', async () => {
  let current = { id: 'before', runtime: { sweepInProgress: true } };
  const h = harness(async () => response(current));
  h.streams[0].open();
  await h.client.refresh();
  assert.equal(h.applied.at(-1).id, 'before');
  h.streams[0].onerror(); h.streams[0].onerror();
  current = { id: 'missed sweep', runtime: { sweepInProgress: false } };
  h.tick(5000);
  assert.equal(h.streams.length, 2);
  h.streams[1].open();
  await h.client.refresh();
  assert.equal(h.applied.at(-1).id, 'missed sweep');
  assert.equal(h.fetches(), 2);
  assert.equal(h.states.at(-1), 'live');
  assert.equal(h.sweeps.at(-1), false);
  h.client.stop();
});

test('an old in-flight snapshot cannot overwrite a newer SSE update', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  h.streams[0].open();
  const request = h.client.refresh();
  h.streams[0].message({ type: 'update', data: { id: 'new' } });
  resolve(response({ id: 'old' }));
  await request;
  assert.deepEqual(h.applied.map(d => d.id), ['new']);
  assert.equal(h.states.at(-1), 'live');
  h.client.stop();
});

test('snapshot failure shows stale status and retries while SSE remains connected', async () => {
  let healthy = false;
  const h = harness(async () => healthy ? response({ id: 'recovered' }) : { ok: false, status: 503 });
  h.streams[0].open();
  await h.client.refresh();
  assert.equal(h.states.at(-1), 'stale');
  healthy = true;
  h.tick(5000);
  await h.client.refresh();
  assert.equal(h.applied.at(-1).id, 'recovered');
  assert.equal(h.states.at(-1), 'live');
  h.client.stop();
});

test('returning to a tab coalesces refreshes; stop cancels listeners and retries', async () => {
  const h = harness(async () => response({ id: 'snapshot' }));
  h.streams[0].open();
  h.listeners.get('visibilitychange')();
  await h.client.refresh();
  assert.equal(h.fetches(), 1);
  h.listeners.get('visibilitychange')();
  await h.client.refresh();
  assert.equal(h.fetches(), 2);
  h.streams[0].message({ type: 'sweep_start' });
  assert.equal(h.sweeps.at(-1), true);
  h.streams[0].message({ type: 'sweep_error', error: 'offline' });
  assert.equal(h.sweeps.at(-1), false);
  h.streams[0].onerror();
  h.client.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  h.tick(5000);
  assert.equal(h.streams.length, 1);
});

test('a hanging snapshot times out without requiring a page reload', async () => {
  const h = harness((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))));
  h.streams[0].open();
  const request = h.client.refresh();
  h.tick(10000);
  await request;
  assert.equal(h.states.at(-1), 'stale');
  assert.equal(h.errors.length, 1);
  h.client.stop();
});
