import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch } from '../apis/utils/fetch.mjs';

describe('safeFetch', () => {
  it('clears timeout handles after fetch failures', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    const timerHandle = { id: 'timer-1' };
    const clearTimeoutCalls = [];

    globalThis.setTimeout = mock.fn(() => timerHandle);
    globalThis.clearTimeout = mock.fn((handle) => {
      clearTimeoutCalls.push(handle);
    });
    globalThis.fetch = mock.fn(() => Promise.reject(new Error('network down')));

    try {
      const result = await safeFetch('https://example.com/feed.json', { retries: 0, timeout: 50 });
      assert.equal(result.error, 'network down');
      assert.deepEqual(clearTimeoutCalls, [timerHandle]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
