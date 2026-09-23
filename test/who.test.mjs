import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { briefing } from '../apis/sources/who.mjs';

const DAY = 86400000;

function don(daysAgo, title) {
  return {
    Title: title,
    PublicationDate: new Date(Date.now() - daysAgo * DAY).toISOString(),
    DonId: `DON-${daysAgo}`,
    ItemDefaultUrl: `/don-${daysAgo}`,
    Summary: '<p>Summary text</p>',
  };
}

async function withFetch(items, fn) {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ value: items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('WHO Disease Outbreak News', () => {
  it('asks the API for newest-first notices and keeps the last 30 days', async () => {
    await withFetch([don(60, 'Old'), don(2, 'Recent'), don(20, 'Middle')], async (urls) => {
      const result = await briefing();
      assert.match(urls[0], /\$orderby=PublicationDateAndTime%20desc/);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.diseaseOutbreakNews.map((item) => item.title), ['Recent', 'Middle']);
      assert.equal(result.diseaseOutbreakNews[0].summary, 'Summary text');
    });
  });

  it('reports an error instead of "no outbreaks" when only archive items come back', async () => {
    await withFetch([don(4000, 'Ancient'), don(900, 'Older')], async () => {
      const result = await briefing();
      assert.deepEqual(result.diseaseOutbreakNews, []);
      assert.match(result.error, /only archive items/);
    });
  });

  it('treats a quiet month as healthy', async () => {
    await withFetch([don(45, 'Last month')], async () => {
      const result = await briefing();
      assert.deepEqual(result.diseaseOutbreakNews, []);
      assert.equal(result.error, undefined);
    });
  });
});
