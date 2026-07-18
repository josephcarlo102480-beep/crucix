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
    }], {}, [], []);

    assert.equal(feed.length, 1);
    assert.equal(feed[0].summary, 'Useful context from the RSS description.');
    assert.equal(feed[0].publisher, 'Example Newsroom');
    assert.equal(feed[0].url, 'https://example.com/story');
  });

  it('keeps full Telegram context and its signal metadata', () => {
    const text = `Initial alert. ${'Additional operational context. '.repeat(20)}`;
    const feed = buildNewsFeed([], {}, [{
      channel: 'intelslava',
      postId: 'intelslava/12345',
      text,
      date: now,
      views: 24500,
      urgentFlags: ['strike', 'drone'],
      score: 42,
      hasMedia: true,
    }], []);

    assert.equal(feed.length, 1);
    assert.equal(feed[0].headline.length, 100);
    assert.equal(feed[0].summary, text.trim());
    assert.equal(feed[0].publisher, 'intelslava');
    assert.equal(feed[0].url, 'https://t.me/intelslava/12345');
    assert.equal(feed[0].views, 24500);
    assert.deepEqual(feed[0].urgentFlags, ['strike', 'drone']);
    assert.equal(feed[0].score, 42);
    assert.equal(feed[0].hasMedia, true);
  });

  it('does not truncate Telegram text while synthesizing dashboard data', async () => {
    const text = `English-language alert. ${'Full message context. '.repeat(25)}`;
    const dashboard = await synthesize({
      crucix: { timestamp: now },
      sources: {
        OpenSky: {},
        Telegram: {
          urgentPosts: [{
            channel: 'examplechannel',
            postId: 'examplechannel/6789',
            text,
            date: now,
            views: 8100,
            urgentFlags: ['alert'],
            score: 18,
          }],
          topPosts: [],
        },
      },
      errors: [],
    });

    assert.equal(dashboard.newsFeed[0].summary, text.trim());
    assert.equal(dashboard.newsFeed[0].url, 'https://t.me/examplechannel/6789');
    assert.equal(dashboard.newsFeed[0].views, 8100);
    assert.deepEqual(dashboard.newsFeed[0].urgentFlags, ['alert']);
  });
});
