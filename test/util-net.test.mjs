import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchWithTimeout, clampInt, isPrivateHost } from '../lib/util/net.mjs';

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/hang') return; // never responds
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
});

describe('fetchWithTimeout', () => {
  it('returns the Response on success', async () => {
    const res = await fetchWithTimeout(`${base}/ok`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('rejects when the timeout fires', async () => {
    await assert.rejects(() => fetchWithTimeout(`${base}/hang`, { timeoutMs: 40 }), (e) => e.name === 'TimeoutError' || e.name === 'AbortError');
  });

  it('rejects when the external signal aborts first', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(
      () => fetchWithTimeout(`${base}/hang`, { timeoutMs: 5000, signal: controller.signal }),
      (e) => e.name === 'AbortError',
    );
  });

  it('passes init options through', async () => {
    const res = await fetchWithTimeout(`${base}/ok`, { method: 'POST', headers: { 'x-test': '1' } });
    assert.equal(res.status, 200);
  });

  it('rejects on a network error', async () => {
    await assert.rejects(() => fetchWithTimeout('http://127.0.0.1:1/nothing', { timeoutMs: 500 }));
  });
});

describe('clampInt', () => {
  it('clamps to the range', () => {
    assert.equal(clampInt('0', { min: 1, max: 4000, fallback: 40 }), 1);
    assert.equal(clampInt('99999', { min: 1, max: 4000, fallback: 40 }), 4000);
    assert.equal(clampInt('250', { min: 1, max: 4000, fallback: 40 }), 250);
    assert.equal(clampInt(-5, { min: 0, max: 10, fallback: 3 }), 0);
  });

  it('falls back on unparseable input', () => {
    const o = { min: 1, max: 10, fallback: 7 };
    assert.equal(clampInt(undefined, o), 7);
    assert.equal(clampInt(null, o), 7);
    assert.equal(clampInt('', o), 7);
    assert.equal(clampInt('   ', o), 7);
    assert.equal(clampInt('abc', o), 7);
    assert.equal(clampInt(NaN, o), 7);
    assert.equal(clampInt(Infinity, o), 7);
  });

  it('truncates floats and tolerates trailing junk', () => {
    assert.equal(clampInt(3.9, { min: 0, max: 10, fallback: 0 }), 3);
    assert.equal(clampInt('12px', { min: 0, max: 100, fallback: 0 }), 12);
  });

  it('uses sane defaults when bounds are omitted', () => {
    assert.equal(clampInt('5'), 5);
    assert.equal(clampInt('x'), 0);
  });
});

describe('isPrivateHost', () => {
  const priv = [
    'localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'printer.local',
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::abcd',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::ffff:192.168.0.1]',
  ];
  for (const h of priv) {
    it(`treats ${h} as private`, () => assert.equal(isPrivateHost(h), true));
  }

  const pub = [
    'example.com', 'crucix.live', 'localhost.example.com', 'notlocal',
    '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', '169.253.0.1',
    '2606:4700:4700::1111', '::ffff:8.8.8.8', '', '   ', null, undefined, 42,
  ];
  for (const h of pub) {
    it(`treats ${JSON.stringify(h)} as public`, () => assert.equal(isPrivateHost(h), false));
  }
});
