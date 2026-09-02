// Shared fetch utility with timeout, retries, and error handling.
//
// safeFetch never rejects: it resolves to parsed JSON on success, `{ rawText }`
// for non-JSON bodies, or `{ error, source }` on failure. Use unwrap()/fetchJson()
// when you would rather handle a thrown error.

/** Promise-based sleep. */
export function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const MAX_RETRY_AFTER_MS = 10_000;

function isPlainBody(body) {
  if (body === null || typeof body !== 'object') return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false;
  return true;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Fetch with timeout, bounded retries and normalised error shape.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout=10000]      per-attempt timeout in ms
 * @param {number} [opts.retries=1]          extra attempts after the first
 * @param {number} [opts.retryDelayMs]       fixed gap between attempts
 * @param {object} [opts.headers]
 * @param {string} [opts.method='GET']
 * @param {string|object} [opts.body]        objects are JSON-stringified
 * @param {'json'|'text'|'response'} [opts.responseType='json']
 * @param {AbortSignal} [opts.signal]        external cancellation
 */
export async function safeFetch(url, opts = {}) {
  const {
    timeout = 10000,
    retries = 1,
    retryDelayMs,
    headers = {},
    method = 'GET',
    body,
    responseType = 'json',
    signal: externalSignal,
  } = opts;

  const aborted = () => ({ error: 'aborted', aborted: true, source: url });

  const requestHeaders = { 'User-Agent': 'Crucix/1.0', ...headers };
  let requestBody = body;
  if (isPlainBody(body)) {
    requestBody = JSON.stringify(body);
    if (!hasHeader(requestHeaders, 'content-type')) {
      requestHeaders['Content-Type'] = 'application/json';
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) return aborted();

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Timeout after ${timeout}ms`)),
      timeout,
    );
    try {
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;

      const res = await fetch(url, {
        method,
        signal,
        headers: requestHeaders,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });

      // Raw Response: hand it back unconsumed, no retries once headers landed.
      if (responseType === 'response') return res;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        err.retryAfter = res.headers.get('retry-after');
        throw err;
      }

      if (responseType === 'text') {
        return {
          text: await res.text(),
          status: res.status,
          headers: Object.fromEntries(res.headers),
        };
      }

      const text = await res.text();
      try { return JSON.parse(text); } catch { return { rawText: text.slice(0, 500) }; }
    } catch (e) {
      lastError = e;
      if (externalSignal?.aborted) return aborted();

      // Network errors and timeouts have no status and are always retryable.
      // HTTP errors: only 429 and 5xx.
      const retryable = e?.status === undefined || isRetryableStatus(e.status);
      if (attempt >= retries || !retryable) break;

      let gap = retryDelayMs ?? 2000 * (attempt + 1);
      if (e?.status === 429 && e.retryAfter != null) {
        const secs = Number(e.retryAfter);
        if (Number.isFinite(secs) && secs >= 0) gap = Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
      }
      await delay(gap);
    } finally {
      clearTimeout(timer);
    }
  }

  const out = { error: lastError?.message || 'Unknown error', source: url };
  if (lastError?.status !== undefined) out.status = lastError.status;
  return out;
}

/**
 * Turn a safeFetch result into a value or a throw.
 * Throws on null/undefined, on `{ error }`, and on a bare `{ rawText }`.
 */
export function unwrap(result, label = 'upstream') {
  const isBareRawText = result != null
    && typeof result === 'object'
    && result.rawText !== undefined
    && Object.keys(result).length === 1;

  if (result == null || result.error !== undefined || isBareRawText) {
    const err = new Error(`${label}: ${result?.error || 'non-JSON response'}`);
    if (result?.status !== undefined) err.status = result.status;
    throw err;
  }
  return result;
}

/** safeFetch + unwrap. Rejects instead of returning an error object. */
export async function fetchJson(url, opts = {}) {
  return unwrap(await safeFetch(url, opts), opts.label || url);
}

export function ago(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

export function today() {
  return new Date().toISOString().split('T')[0];
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
