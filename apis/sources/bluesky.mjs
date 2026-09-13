// Bluesky — AT Protocol social intelligence
// No auth required for public search. Real-time social sentiment on geopolitical/market topics.
// Public API: app.bsky.feed.searchPosts (full-text search, sorted by latest)

import { safeFetch, delay } from '../utils/fetch.mjs';

// Search is available on the direct AppView. The cached public host rejects
// searchPosts with 403 even while other public endpoints remain accessible.
const BASE = 'https://api.bsky.app/xrpc';

// Search public posts by query string
export async function searchPosts(query, opts = {}) {
  const { limit = 25, sort = 'latest', signal } = opts;
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    sort,
  });
  // One short attempt: the sweep budget is 30s and three queries run in series.
  return safeFetch(`${BASE}/app.bsky.feed.searchPosts?${params}`, {
    timeout: 8000,
    retries: 0,
    signal,
  });
}

// Compact a post for briefing output
function compactPost(post) {
  const record = post?.record || post;
  const author = post?.author;
  return {
    text: (record?.text || '').slice(0, 200),
    author: author?.handle || author?.displayName || 'unknown',
    date: record?.createdAt || null,
    likes: post?.likeCount ?? 0,
  };
}

// Categorize posts by topic bucket based on keyword matching
function categorize(posts, keywords) {
  return posts.filter(p =>
    keywords.some(k => p.text?.toLowerCase().includes(k))
  );
}

// Briefing — search key geopolitical/market terms and categorize
export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const searchQueries = [
    { label: 'conflict', q: 'Iran war OR missile strike OR sanctions' },
    { label: 'markets', q: 'market crash OR oil prices OR gold OR recession' },
    { label: 'health', q: 'pandemic OR outbreak OR epidemic' },
  ];

  const topicResults = {};
  const errors = [];

  for (let i = 0; i < searchQueries.length; i++) {
    const { label, q } = searchQueries[i];
    const result = await searchPosts(q, { limit: 25, signal });

    if (!result || result.error || !Array.isArray(result.posts)) {
      errors.push(`${label}: ${result?.error || 'response had no posts array'}`);
      topicResults[label] = [];
    } else {
      topicResults[label] = result.posts.map(compactPost);
    }

    // Be polite between searches — but not after the last one, which only
    // burned 1.5s of the sweep budget for nothing.
    if (i < searchQueries.length - 1 && !signal?.aborted) await delay(1500);
  }

  return {
    source: 'Bluesky',
    timestamp: new Date().toISOString(),
    topics: {
      conflict: topicResults.conflict || [],
      markets: topicResults.markets || [],
      health: topicResults.health || [],
    },
    ...(errors.length ? {
      error: errors.length === searchQueries.length
        ? `Bluesky search failed for all topics: ${errors[0]}`
        : `Bluesky search failed for ${errors.length}/${searchQueries.length} topics: ${errors.join('; ')}`,
    } : {}),
  };
}

// Run standalone
if (process.argv[1]?.endsWith('bluesky.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
