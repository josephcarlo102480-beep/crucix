// Reddit — social sentiment intelligence
// Reddit now requires OAuth for API access (public JSON API returns 403).
// Gracefully degrades when not authenticated.
// To enable: register an app at https://www.reddit.com/prefs/apps/ and set
// REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env

import { safeFetch, delay } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const SUBREDDITS = [
  'worldnews',
  'geopolitics',
  'economics',
  'wallstreetbets',
  'commodities',
];

// Get OAuth token using client credentials flow (application-only).
// Returns `{ token }`, `{ error }`, or `{}` when no credentials are configured.
// The old version had no timeout at all, so a hung Reddit login could eat the
// whole sweep budget before the first subreddit was ever requested.
async function getToken(signal) {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return {};

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const data = await safeFetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    timeout: 8000,
    retries: 0,
    signal,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Crucix/1.0 intelligence-engine',
    },
    body: 'grant_type=client_credentials',
  });

  if (!data || data.error) return { error: data?.error || 'no response from Reddit token endpoint' };
  if (!data.access_token) {
    return { error: `Reddit token response had no access_token${data.rawText !== undefined ? `: ${String(data.rawText).slice(0, 100)}` : ''}` };
  }
  return { token: data.access_token };
}

// Fetch hot posts — tries OAuth first, then falls back to public endpoint
export async function getHot(subreddit, opts = {}) {
  const { limit = 10, token = null, signal } = opts;

  if (token) {
    // Use OAuth endpoint
    return safeFetch(`https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}&raw_json=1`, {
      timeout: 10000,
      retries: 0,
      signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Crucix/1.0 intelligence-engine',
      },
    });
  }

  // Try public endpoint (may 403)
  return safeFetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`, {
    timeout: 10000,
    retries: 0,
    signal,
    headers: { 'User-Agent': 'Crucix/1.0 intelligence-engine' },
  });
}

function compactPost(child) {
  const d = child?.data;
  if (!d) return null;
  return {
    title: d.title,
    score: d.score ?? 0,
    comments: d.num_comments ?? 0,
    url: d.url,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
  };
}

export async function briefing(opts = {}) {
  const { signal } = opts || {};
  const { token, error: tokenError } = await getToken(signal);

  if (!token && !process.env.REDDIT_CLIENT_ID) {
    return {
      source: 'Reddit',
      timestamp: new Date().toISOString(),
      status: 'no_key',
      message: 'Reddit requires OAuth. Register at https://www.reddit.com/prefs/apps/ (script type), set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env',
    };
  }

  // Credentials are configured but the login failed. Falling through to the
  // public endpoint just trades one real error for five silent 403s.
  if (!token) {
    return {
      source: 'Reddit',
      timestamp: new Date().toISOString(),
      error: `Reddit OAuth failed: ${tokenError || 'unknown error'}`,
      subreddits: {},
    };
  }

  const subredditResults = {};
  const errors = [];

  for (let i = 0; i < SUBREDDITS.length; i++) {
    const sub = SUBREDDITS[i];
    const result = await getHot(sub, { limit: 10, token, signal });

    if (!result || result.error || !Array.isArray(result.data?.children)) {
      errors.push(`r/${sub}: ${result?.error || 'response had no listing'}`);
      subredditResults[sub] = [];
    } else {
      subredditResults[sub] = result.data.children.map(compactPost).filter(Boolean);
    }

    if (i < SUBREDDITS.length - 1 && !signal?.aborted) await delay(1000);
  }

  return {
    source: 'Reddit',
    timestamp: new Date().toISOString(),
    subreddits: subredditResults,
    ...(errors.length ? {
      error: errors.length === SUBREDDITS.length
        ? `Reddit unavailable for all subreddits: ${errors[0]}`
        : `Reddit unavailable for ${errors.length}/${SUBREDDITS.length} subreddits: ${errors.join('; ')}`,
    } : {}),
  };
}

if (process.argv[1]?.endsWith('reddit.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
