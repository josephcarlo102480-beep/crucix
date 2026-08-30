import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNewsFeed, synthesize } from '../dashboard/inject.mjs';

const now = new Date().toISOString();
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async () => ({
    text: async () => '<rss><channel></channel></rss>',
  });
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe('dashboard ticker data', () => {
  it('keeps RSS summaries, publisher names, and source links', () => {
    const feed = buildNewsFeed([{
      title: 'Regional headline',
      summary: 'Useful context from the RSS description.',
      publisher: 'Example Newsroom',
      source: 'BBC',
      date: now,
      region: 'Europe',
      url: 'https://example.com/story',
    }], {});

    assert.equal(feed.length, 1);
    assert.equal(feed[0].summary, 'Useful context from the RSS description.');
    assert.equal(feed[0].publisher, 'Example Newsroom');
    assert.equal(feed[0].url, 'https://example.com/story');
  });

  it('keeps GDELT headlines when synthesizing dashboard data', async () => {
    const dashboard = await synthesize({
      crucix: { timestamp: now },
      sources: {
        OpenSky: {},
        GDELT: {
          allArticles: [{
            title: 'Example geopolitical headline for the ticker',
            summary: 'Context from GDELT.',
            domain: 'example.com',
            date: now,
            url: 'https://example.com/gdelt-story',
          }],
        },
      },
      errors: [],
    });

    assert.equal(dashboard.newsFeed[0].headline, 'Example geopolitical headline for the ticker');
    assert.equal(dashboard.newsFeed[0].summary, 'Context from GDELT.');
    assert.equal(dashboard.newsFeed[0].url, 'https://example.com/gdelt-story');
  });
});
