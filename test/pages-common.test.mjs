/**
 * The shared browser helpers in dashboard/public/js/crucix-common.js.
 *
 * It is a classic browser script, so it is loaded into a vm context with a
 * hand-rolled `window` rather than imported — which also lets the storage
 * tests hand it a Storage that throws on every access, the way Safari's
 * private mode and a blocked-cookies profile actually behave.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'dashboard/public/js/crucix-common.js'), 'utf8');

/** Fresh sandbox per test — nothing leaks between them. */
function load({ localStorage, sessionStorage, href = 'https://crucix.live/page.html' } = {}) {
  const sandbox = { URL, console, location: { href } };
  if (localStorage) sandbox.localStorage = localStorage;
  if (sessionStorage) sandbox.sessionStorage = sessionStorage;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  assert.ok(sandbox.CrucixCommon, 'CrucixCommon was not installed on the global');
  return sandbox.CrucixCommon;
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

function throwingStorage() {
  const boom = () => { throw new Error('SecurityError: storage is disabled'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

test('crucix-common exposes the documented surface', () => {
  const C = load();
  for (const name of ['escapeHtml', 'safeExternalUrl', 'safeStorage', 'subsolar', 'latLngToVec3']) {
    assert.ok(name in C, `missing ${name}`);
  }
  for (const name of ['get', 'set', 'remove']) {
    assert.equal(typeof C.safeStorage[name], 'function', `safeStorage.${name}`);
  }
});

test('escapeHtml neutralises every HTML-significant character', () => {
  const C = load();
  assert.equal(
    C.escapeHtml(`<img src=x onerror="alert('xss')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;',
  );
  // Nullish input must not print "null"/"undefined" into the page.
  assert.equal(C.escapeHtml(null), '');
  assert.equal(C.escapeHtml(undefined), '');
  assert.equal(C.escapeHtml(0), '0');
  assert.equal(C.escapeHtml(false), 'false');
});

test('safeExternalUrl passes http(s) and rejects everything else', () => {
  const C = load();
  assert.equal(C.safeExternalUrl('https://example.org/a?b=1'), 'https://example.org/a?b=1');
  assert.equal(C.safeExternalUrl('http://example.org/'), 'http://example.org/');
  // Relative URLs resolve against the document.
  assert.equal(C.safeExternalUrl('/feed'), 'https://crucix.live/feed');
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '',
    null,
    undefined,
    {},
  ]) {
    assert.equal(C.safeExternalUrl(hostile), '', `should have rejected ${String(hostile)}`);
  }
});

test('safeStorage round-trips JSON values', () => {
  const store = memoryStorage();
  const C = load({ localStorage: store });
  assert.equal(C.safeStorage.get('missing', 'fallback'), 'fallback');
  assert.equal(C.safeStorage.set('view', { mode: 'map', n: 3 }), true);
  assert.equal(store._map.get('view'), '{"mode":"map","n":3}');
  // Spread copies the sandbox-realm object into this realm so the strict deep-equal prototype check passes.
  assert.deepEqual({ ...C.safeStorage.get('view') }, { mode: 'map', n: 3 });
  assert.equal(C.safeStorage.remove('view'), true);
  assert.equal(C.safeStorage.get('view', null), null);
  // A default of `null` is returned when nothing was stored.
  assert.equal(C.safeStorage.get('never-written'), null);
});

test('safeStorage swallows a storage that throws on every access', () => {
  const C = load({ localStorage: throwingStorage(), sessionStorage: throwingStorage() });
  assert.equal(C.safeStorage.get('k', 'fallback'), 'fallback');
  assert.equal(C.safeStorage.set('k', 'v'), false);
  assert.equal(C.safeStorage.remove('k'), false);
  assert.equal(C.safeStorage.session.get('k', 7), 7);
  assert.equal(C.safeStorage.session.set('k', 'v'), false);
});

test('safeStorage survives a missing storage object and corrupt JSON', () => {
  const C = load();                                   // no localStorage at all
  assert.equal(C.safeStorage.get('k', 'fallback'), 'fallback');
  assert.equal(C.safeStorage.set('k', 'v'), false);

  const D = load({ localStorage: memoryStorage({ bad: '{not json' }) });
  assert.equal(D.safeStorage.get('bad', 'fallback'), 'fallback');
});

test('safeStorage.session is backed by sessionStorage, not localStorage', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const C = load({ localStorage: local, sessionStorage: session });
  C.safeStorage.session.set('token', 'abc');
  assert.equal(session._map.get('token'), '"abc"');
  assert.equal(local._map.has('token'), false);
  assert.equal(C.safeStorage.session.get('token'), 'abc');
});

test('subsolar puts the Sun over the tropic at the solstices', () => {
  const C = load();
  const june = C.subsolar(new Date('2026-06-21T12:00:00Z'));
  assert.ok(Math.abs(june.lat - 23.4) < 0.2, `June solstice lat was ${june.lat}`);
  assert.ok(Math.abs(june.lng) < 3, `June solstice lng was ${june.lng}`);

  const december = C.subsolar(new Date('2026-12-21T12:00:00Z'));
  assert.ok(Math.abs(december.lat + 23.4) < 0.2, `December solstice lat was ${december.lat}`);
  assert.ok(Math.abs(december.lng) < 3, `December solstice lng was ${december.lng}`);

  // Equinox: the Sun sits on the equator.
  const march = C.subsolar(new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(march.lat) < 0.6, `March equinox lat was ${march.lat}`);
});

test('subsolar accepts a Date, epoch ms or a string, and longitude stays in range', () => {
  const C = load();
  const ms = Date.UTC(2026, 5, 21, 12, 0, 0);
  assert.deepEqual(C.subsolar(ms), C.subsolar(new Date(ms)));
  assert.deepEqual(C.subsolar('2026-06-21T12:00:00Z'), C.subsolar(new Date(ms)));

  // Sweep a full day: the subsolar point must never leave [-180, 180).
  for (let h = 0; h < 24; h += 1) {
    const { lat, lng } = C.subsolar(Date.UTC(2026, 2, 14, h));
    assert.ok(lng >= -180 && lng < 180, `lng ${lng} out of range at hour ${h}`);
    assert.ok(lat >= -23.5 && lat <= 23.5, `lat ${lat} out of range at hour ${h}`);
  }
});

test('latLngToVec3 returns unit vectors in three-globe orientation', () => {
  const C = load();
  const len = (v) => Math.hypot(v.x, v.y, v.z);

  for (const [lat, lng] of [[0, 0], [23.4, 45], [-51.5, -179.9], [90, 0], [-90, 137]]) {
    assert.ok(Math.abs(len(C.latLngToVec3(lat, lng)) - 1) < 1e-12, `not unit at ${lat},${lng}`);
  }

  // 0°N 0°E points down +Z; the north pole points up +Y; 90°E points down +X.
  const origin = C.latLngToVec3(0, 0);
  assert.ok(Math.abs(origin.z - 1) < 1e-12 && Math.abs(origin.x) < 1e-12);
  const pole = C.latLngToVec3(90, 0);
  assert.ok(Math.abs(pole.y - 1) < 1e-12);
  const east = C.latLngToVec3(0, 90);
  assert.ok(Math.abs(east.x - 1) < 1e-12);

  // The radius argument scales the vector.
  const scaled = C.latLngToVec3(30, 120, 100);
  assert.ok(Math.abs(len(scaled) - 100) < 1e-9);
});
