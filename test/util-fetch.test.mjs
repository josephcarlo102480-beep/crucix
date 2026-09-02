import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { safeFetch, unwrap, fetchJson, delay } from '../apis/utils/fetch.mjs';
import { parseEnv } from '../apis/utils/env.mjs';

// One server for the whole file; each test picks a route.
let server;
let base;
const hits = new Map();
const routes = new Map();

function route(path, handler) {
  routes.set(path, handler);
  hits.set(path, 0);
  return `${base}${path}`;
}

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.set(path, (hits.get(path) || 0) + 1);
    const handler = routes.get(path);
    if (!handler) { res.writeHead(404); res.end('no route'); return; }
    handler(req, res, hits.get(path));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
});

describe('safeFetch retry policy', () => {
  it('does not retry a 404 and reports the status', async () => {
    const url = route('/notfound', (req, res) => { res.writeHead(404); res.end('nope'); });
    const result = await safeFetch(url, { retries: 3, retryDelayMs: 5 });
    assert.equal(hits.get('/notfound'), 1, 'must not retry 4xx');
    assert.equal(result.status, 404);
    assert.match(result.error, /^HTTP 404: nope/);
    assert.equal(result.source, url);
  });

  it('retries a 503 until it succeeds', async () => {
    const url = route('/flaky', (req, res, n) => {
      if (n < 3) { res.writeHead(503); res.end('busy'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const result = await safeFetch(url, { retries: 2, retryDelayMs: 5 });
    assert.equal(hits.get('/flaky'), 3);
    assert.deepEqual(result, { ok: true });
  });

  it('gives up after the last retry and keeps the status', async () => {
    const url = route('/always500', (req, res) => { res.writeHead(500); res.end('boom'); });
    const result = await safeFetch(url, { retries: 1, retryDelayMs: 5 });
    assert.equal(hits.get('/always500'), 2);
    assert.equal(result.status, 500);
  });

  it('honours a numeric Retry-After on 429 instead of the default gap', async () => {
    const url = route('/ratelimited', (req, res, n) => {
      if (n === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end('slow down'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"recovered":true}');
    });
    const started = Date.now();
    const result = await safeFetch(url, { retries: 1 }); // no retryDelayMs => default 2000ms
    const elapsed = Date.now() - started;
    assert.equal(hits.get('/ratelimited'), 2);
    assert.deepEqual(result, { recovered: true });
    assert.ok(elapsed < 1000, `expected Retry-After: 0 to skip the 2s default gap, waited ${elapsed}ms`);
  });

  it('retries network errors', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('network down'); };
    try {
      const result = await safeFetch('http://127.0.0.1:1/x', { retries: 2, retryDelayMs: 1 });
      assert.equal(calls, 3);
      assert.equal(result.error, 'network down');
      assert.equal(result.status, undefined);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('safeFetch cancellation', () => {
  it('returns an aborted result when the external signal fires', async () => {
    const url = route('/hang', () => { /* never responds */ });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    const result = await safeFetch(url, { retries: 2, timeout: 5000, signal: controller.signal });
    assert.deepEqual(result, { error: 'aborted', aborted: true, source: url });
    assert.equal(hits.get('/hang'), 1, 'aborting must stop further attempts');
  });

  it('times out slow responses', async () => {
    const url = route('/slow', (req, res) => { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000).unref?.(); });
    const result = await safeFetch(url, { retries: 0, timeout: 40 });
    assert.match(result.error, /Timeout after 40ms/);
  });
});

describe('safeFetch response handling', () => {
  it('wraps non-JSON bodies in rawText', async () => {
    const url = route('/html', (req, res) => { res.writeHead(200); res.end('<html>hi</html>'); });
    const result = await safeFetch(url, { retries: 0 });
    assert.deepEqual(result, { rawText: '<html>hi</html>' });
  });

  it("responseType 'text' returns text, status and headers", async () => {
    const url = route('/text', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv', 'x-custom': 'yes' });
      res.end('a,b\n1,2');
    });
    const result = await safeFetch(url, { retries: 0, responseType: 'text' });
    assert.equal(result.text, 'a,b\n1,2');
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-custom'], 'yes');
  });

  it("responseType 'response' returns the unconsumed Response", async () => {
    const url = route('/raw', (req, res) => { res.writeHead(201); res.end('body-here'); });
    const res = await safeFetch(url, { retries: 0, responseType: 'response' });
    assert.equal(res.status, 201);
    assert.equal(res.bodyUsed, false);
    assert.equal(await res.text(), 'body-here');
  });

  it("responseType 'response' does not retry a 5xx once headers arrived", async () => {
    const url = route('/raw500', (req, res) => { res.writeHead(500); res.end('x'); });
    const res = await safeFetch(url, { retries: 3, retryDelayMs: 1, responseType: 'response' });
    assert.equal(res.status, 500);
    assert.equal(hits.get('/raw500'), 1);
  });

  it('POSTs an object body as JSON', async () => {
    const url = route('/echo', (req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, contentType: req.headers['content-type'], body }));
      });
    });
    const result = await safeFetch(url, { retries: 0, method: 'POST', body: { hello: 'world' } });
    assert.equal(result.method, 'POST');
    assert.equal(result.contentType, 'application/json');
    assert.equal(result.body, '{"hello":"world"}');
  });

  it('leaves a string body and a caller Content-Type alone', async () => {
    const url = route('/echo2', (req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ contentType: req.headers['content-type'], body }));
      });
    });
    const result = await safeFetch(url, {
      retries: 0, method: 'POST', body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(result.contentType, 'application/x-www-form-urlencoded');
    assert.equal(result.body, 'a=1');
  });
});

describe('unwrap', () => {
  it('throws on an error result and copies the status', () => {
    try {
      unwrap({ error: 'HTTP 403: denied', status: 403, source: 'u' }, 'ACLED');
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.message, 'ACLED: HTTP 403: denied');
      assert.equal(e.status, 403);
    }
  });

  it('throws on a bare rawText result', () => {
    assert.throws(() => unwrap({ rawText: '<html>' }, 'GDELT'), /GDELT: non-JSON response/);
  });

  it('throws on null/undefined', () => {
    assert.throws(() => unwrap(null), /upstream: non-JSON response/);
    assert.throws(() => unwrap(undefined, 'WHO'), /WHO: non-JSON response/);
  });

  it('passes through a good payload, including one with a rawText field of its own', () => {
    const good = { items: [1, 2] };
    assert.equal(unwrap(good), good);
    const withExtra = { rawText: 'x', items: [] };
    assert.equal(unwrap(withExtra), withExtra);
  });
});

describe('fetchJson', () => {
  it('resolves parsed JSON', async () => {
    const url = route('/json', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"n":7}');
    });
    assert.deepEqual(await fetchJson(url, { retries: 0 }), { n: 7 });
  });

  it('rejects with the label on failure', async () => {
    const url = route('/json403', (req, res) => { res.writeHead(403); res.end('denied'); });
    await assert.rejects(
      () => fetchJson(url, { retries: 0, label: 'TestAPI' }),
      (e) => e.message.startsWith('TestAPI: HTTP 403') && e.status === 403,
    );
  });

  it('defaults the label to the url', async () => {
    const url = route('/json404', (req, res) => { res.writeHead(404); res.end('gone'); });
    await assert.rejects(() => fetchJson(url, { retries: 0 }), new RegExp(`^Error: ${url}: HTTP 404`));
  });
});

describe('delay', () => {
  it('resolves after roughly the requested time', async () => {
    const started = Date.now();
    await delay(20);
    assert.ok(Date.now() - started >= 15);
  });
});

// env.mjs lives next door in apis/utils/ and loads on import from two fixed
// paths, so the parser is exercised directly rather than via a temp .env.
describe('env parsing', () => {
  it('strips surrounding double and single quotes', () => {
    const env = parseEnv('A="quoted value"\nB=\'single\'\n');
    assert.equal(env.A, 'quoted value');
    assert.equal(env.B, 'single');
  });

  it('strips only one matching pair', () => {
    const env = parseEnv('A=""nested""\nB="unbalanced\nC=mixed\'\n');
    assert.equal(env.A, '"nested"');
    assert.equal(env.B, '"unbalanced');
    assert.equal(env.C, "mixed'");
  });

  it('tolerates a leading export', () => {
    const env = parseEnv('export KEY=abc\nexport   OTHER="x y"\n');
    assert.equal(env.KEY, 'abc');
    assert.equal(env.OTHER, 'x y');
  });

  it('skips comments and blank lines, and keeps = inside values', () => {
    const env = parseEnv('# comment\n\n  \nTOKEN=a=b=c\nNOEQUALS\n');
    assert.deepEqual(Object.keys(env), ['TOKEN']);
    assert.equal(env.TOKEN, 'a=b=c');
  });

  it('keeps empty values and trims whitespace', () => {
    const env = parseEnv('  SPACED  =  val  \nEMPTY=\nQUOTED_EMPTY=""\n');
    assert.equal(env.SPACED, 'val');
    assert.equal(env.EMPTY, '');
    assert.equal(env.QUOTED_EMPTY, '');
  });
});
