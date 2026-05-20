import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('server module lifecycle', () => {
  it('does not start the app when imported', async () => {
    const previousNoBrowser = process.env.CRUCIX_NO_BROWSER;
    process.env.CRUCIX_NO_BROWSER = '1';
    const beforeHandles = new Set(process._getActiveHandles?.() || []);

    try {
      const mod = await import(`../server.mjs?import-test=${Date.now()}`);
      await new Promise(resolve => setTimeout(resolve, 25));

      assert.equal(typeof mod.start, 'function');
      assert.equal(typeof mod.shutdown, 'function');

      const newHandles = (process._getActiveHandles?.() || [])
        .filter(handle => !beforeHandles.has(handle));
      assert.deepEqual(newHandles.map(handle => handle.constructor?.name || 'unknown'), []);
    } finally {
      if (previousNoBrowser == null) delete process.env.CRUCIX_NO_BROWSER;
      else process.env.CRUCIX_NO_BROWSER = previousNoBrowser;
    }
  });
});
