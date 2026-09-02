// Stale-while-revalidate cache.
//
// get() serves a cached value immediately and refreshes it in the background
// once it goes stale, so a slow or flaky upstream never blocks a request that
// already has something good enough to show. Loads are single-flight: N
// concurrent callers share one load(). A failed load keeps the previous value
// and backs off before trying again.

/**
 * @param {object} opts
 * @param {number} opts.ttlMs                  age after which a value is stale
 * @param {number} [opts.failureBackoffMs=60000] quiet period after a failed load
 * @param {() => Promise<any>} opts.load       loader; may reject
 * @param {any} [opts.initial]                 seed value (treated as fresh)
 * @param {(err: Error) => void} [opts.onError]
 */
export function createSwrCache({ ttlMs, failureBackoffMs = 60_000, load, initial = undefined, onError } = {}) {
  if (typeof load !== 'function') throw new TypeError('createSwrCache: load must be a function');

  let value = initial;
  let fetchedAt = initial === undefined ? 0 : Date.now();
  let inflight = null;
  let nextAttemptAt = 0;
  let lastError = null;

  const hasValue = () => value !== undefined;
  const isStale = () => !hasValue() || Date.now() - fetchedAt >= ttlMs;

  function startLoad() {
    if (inflight) return inflight;
    inflight = (async () => load())()
      .then(v => {
        value = v;
        fetchedAt = Date.now();
        nextAttemptAt = 0;
        lastError = null;
        return v;
      })
      .catch(err => {
        lastError = err;
        nextAttemptAt = Date.now() + failureBackoffMs;
        if (onError) { try { onError(err); } catch { /* listener must not break the cache */ } }
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    /** Fresh value, or stale value + background refresh, or awaited first load. */
    async get() {
      if (hasValue() && !isStale()) return value;

      if (hasValue()) {
        // Stale: revalidate in the background, serve what we have right now.
        if (Date.now() >= nextAttemptAt || inflight) startLoad().catch(() => {});
        return value;
      }

      // Nothing cached: we have to wait.
      if (!inflight && Date.now() < nextAttemptAt) {
        throw lastError ?? new Error('swr: load failed and is in backoff');
      }
      return startLoad();
    },

    /** Non-blocking snapshot; never triggers a load. */
    peek() {
      return { value, fetchedAt, stale: isStale(), refreshing: inflight !== null };
    },

    /** Force a load now (ignores ttl and backoff); joins an in-flight load. */
    refresh() {
      return startLoad();
    },

    /** Drop the cached value and any backoff so the next get() loads afresh. */
    invalidate() {
      value = undefined;
      fetchedAt = 0;
      nextAttemptAt = 0;
      lastError = null;
    },
  };
}
