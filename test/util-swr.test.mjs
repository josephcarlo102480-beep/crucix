import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSwrCache } from '../lib/util/swr.mjs';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createSwrCache', () => {
  it('awaits the first load when nothing is cached', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 1000, load: async () => { calls++; return 'v1'; } });
    assert.deepEqual(cache.peek(), { value: undefined, fetchedAt: 0, stale: true, refreshing: false });
    assert.equal(await cache.get(), 'v1');
    assert.equal(calls, 1);
    const snap = cache.peek();
    assert.equal(snap.value, 'v1');
    assert.equal(snap.stale, false);
    assert.equal(snap.refreshing, false);
  });

  it('serves a fresh value without reloading', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 1000, load: async () => { calls++; return calls; } });
    await cache.get();
    await cache.get();
    await cache.get();
    assert.equal(calls, 1);
  });

  it('is single-flight for concurrent cold gets', async () => {
    let calls = 0;
    const gate = deferred();
    const cache = createSwrCache({ ttlMs: 1000, load: async () => { calls++; await gate.promise; return 'shared'; } });
    const all = Promise.all([cache.get(), cache.get(), cache.get()]);
    await tick(5);
    assert.equal(calls, 1);
    assert.equal(cache.peek().refreshing, true);
    gate.resolve();
    assert.deepEqual(await all, ['shared', 'shared', 'shared']);
  });

  it('serves the stale value immediately and refreshes in the background', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 10, load: async () => { calls++; return `v${calls}`; } });
    assert.equal(await cache.get(), 'v1');
    await tick(25);
    assert.equal(cache.peek().stale, true);

    assert.equal(await cache.get(), 'v1', 'stale value is returned right away');
    assert.equal(calls, 2, 'a background refresh was kicked off');

    await tick(5);
    assert.equal(await cache.get(), 'v2');
    assert.equal(calls, 2, 'the refreshed value is fresh again');
  });

  it('runs only one background refresh for several stale gets', async () => {
    let calls = 0;
    const gate = deferred();
    const cache = createSwrCache({
      ttlMs: 10,
      load: async () => { calls++; if (calls > 1) await gate.promise; return `v${calls}`; },
    });
    await cache.get();
    await tick(25);
    assert.equal(await cache.get(), 'v1');
    assert.equal(await cache.get(), 'v1');
    assert.equal(await cache.get(), 'v1');
    assert.equal(calls, 2);
    gate.resolve();
    await tick(5);
    assert.equal(await cache.get(), 'v2');
  });

  it('keeps the old value and backs off when a refresh fails', async () => {
    let calls = 0;
    const errors = [];
    const cache = createSwrCache({
      ttlMs: 10,
      failureBackoffMs: 10_000,
      onError: e => errors.push(e.message),
      load: async () => {
        calls++;
        if (calls === 1) return 'good';
        throw new Error('upstream down');
      },
    });
    assert.equal(await cache.get(), 'good');
    await tick(25);

    assert.equal(await cache.get(), 'good'); // triggers the failing refresh
    await tick(5);
    assert.equal(calls, 2);
    assert.deepEqual(errors, ['upstream down']);
    assert.equal(cache.peek().value, 'good', 'old value survives the failure');

    // Still stale, but inside the backoff window: no further load attempts.
    assert.equal(await cache.get(), 'good');
    assert.equal(await cache.get(), 'good');
    assert.equal(calls, 2, 'must not hammer a failing upstream');
  });

  it('retries once the failure backoff expires', async () => {
    let calls = 0;
    const cache = createSwrCache({
      ttlMs: 5,
      failureBackoffMs: 30,
      load: async () => { calls++; if (calls === 2) throw new Error('blip'); return `v${calls}`; },
    });
    assert.equal(await cache.get(), 'v1');
    await tick(15);
    await cache.get();          // load #2 fails
    await tick(5);
    assert.equal(calls, 2);
    await cache.get();          // still in backoff
    assert.equal(calls, 2);
    await tick(40);             // backoff expired
    assert.equal(await cache.get(), 'v1');
    await tick(5);
    assert.equal(calls, 3);
    assert.equal(await cache.get(), 'v3');
  });

  it('rejects a cold get when the load fails, and stays in backoff', async () => {
    let calls = 0;
    const cache = createSwrCache({
      ttlMs: 1000,
      failureBackoffMs: 10_000,
      load: async () => { calls++; throw new Error('cold failure'); },
    });
    await assert.rejects(() => cache.get(), /cold failure/);
    await assert.rejects(() => cache.get(), /cold failure/);
    assert.equal(calls, 1, 'backoff prevents a second attempt');
  });

  it('treats an initial value as fresh', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 1000, initial: 'seed', load: async () => { calls++; return 'loaded'; } });
    assert.equal(cache.peek().stale, false);
    assert.equal(await cache.get(), 'seed');
    assert.equal(calls, 0);
  });

  it('refresh() loads even when fresh, and joins an in-flight load', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 10_000, load: async () => { calls++; return `v${calls}`; } });
    assert.equal(await cache.get(), 'v1');
    assert.equal(await cache.refresh(), 'v2');
    assert.equal(calls, 2);
    const both = await Promise.all([cache.refresh(), cache.refresh()]);
    assert.deepEqual(both, ['v3', 'v3']);
    assert.equal(calls, 3);
  });

  it('invalidate() forces the next get to load afresh', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 10_000, load: async () => { calls++; return `v${calls}`; } });
    assert.equal(await cache.get(), 'v1');
    cache.invalidate();
    assert.equal(cache.peek().value, undefined);
    assert.equal(await cache.get(), 'v2');
    assert.equal(calls, 2);
  });

  it('peek() never triggers a load', async () => {
    let calls = 0;
    const cache = createSwrCache({ ttlMs: 1, load: async () => { calls++; return 'v'; } });
    cache.peek();
    cache.peek();
    assert.equal(calls, 0);
  });

  it('requires a load function', () => {
    assert.throws(() => createSwrCache({ ttlMs: 1 }), TypeError);
  });
});
