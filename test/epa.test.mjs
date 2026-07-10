import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { briefing } from '../apis/sources/epa.mjs';

describe('EPA source deadline behavior', () => {
  it('joins recent results with locations and serves stale data after a refresh failure', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const urls = [];
    try {
      globalThis.fetch = async (url) => {
        calls++;
        urls.push(String(url));
        const body = calls === 1
          ? [{
              ana_num: 10,
              samp_num: 20,
              loc_num: 30,
              analyte_id: 'BETA',
              result_amount: 0.01,
              result_unit: 'PCI/M3',
              result_date: '2026-06-25',
              mat_id: 'AIR-FILTER',
            }]
          : [{ loc_num: 30, city_name: 'CHICAGO', state_abbr: 'IL', station: 'CHICAGO' }];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const fresh = await briefing();
      assert.equal(calls, 2);
      assert.equal(fresh.stale, undefined);
      assert.equal(fresh.totalReadings, 1);
      assert.equal(fresh.readings[0].location, 'CHICAGO');
      assert.equal(fresh.readings[0].analyte, 'GROSS BETA');
      assert.match(urls[0], /data\.epa\.gov\/dmapservice/);
      assert.match(urls[0], /sort\/radnet\.erm_result\.result_date:desc/);

      globalThis.fetch = async () => {
        throw new Error('EPA unavailable');
      };
      const stale = await briefing();
      assert.equal(stale.stale, true);
      assert.match(stale.error, /EPA unavailable/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
