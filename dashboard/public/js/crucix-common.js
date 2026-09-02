/**
 * crucix-common.js — the handful of helpers every Crucix page needs.
 *
 * Load this as a CLASSIC script BEFORE any page script (inline or module) and
 * before /js/globe-fx.js, /js/sat-engine.js and /js/sat-globe3d.js, which all
 * read `window.CrucixCommon` at call time:
 *
 *   <script src="/js/crucix-common.js"></script>
 *
 * ES-module scripts can read the global too — it is installed synchronously.
 *
 * Global: window.CrucixCommon
 *   escapeHtml(value)            → HTML-escaped string
 *   safeExternalUrl(url)         → absolute http(s) URL, or '' when unusable
 *   safeStorage.get/set/remove   → JSON-encoded localStorage, never throws
 *   safeStorage.session.*        → same, backed by sessionStorage
 *   subsolar(date)               → { lat, lng } of the point the Sun is over
 *   latLngToVec3(lat, lng, r)    → { x, y, z } in three-globe's frame
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;

  const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  /** Escape a value for interpolation into HTML text or a quoted attribute. */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]);
  }

  /**
   * Resolve `url` against the current document and return it only when it is
   * http(s). Anything else — javascript:, data:, a parse failure, null — comes
   * back as the empty string, which is falsy at every call site.
   */
  function safeExternalUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return '';
    try {
      const base = typeof global.location !== 'undefined' ? global.location.href : undefined;
      const parsed = base ? new URL(url, base) : new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
    } catch {
      return '';
    }
  }

  /**
   * Web Storage wrapper. Every access is guarded: Safari private mode, a
   * disabled-cookies profile and a full quota all throw on plain access, and a
   * dashboard must not die because a preference could not be remembered.
   * Values are JSON-encoded so non-strings survive the round trip.
   */
  function makeSafeStorage(pick) {
    return {
      get(key, fallback = null) {
        try {
          const store = pick();
          if (!store) return fallback;
          const raw = store.getItem(key);
          if (raw === null || raw === undefined) return fallback;
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          const store = pick();
          if (!store) return false;
          store.setItem(key, JSON.stringify(value));
          return true;
        } catch {
          return false;
        }
      },
      remove(key) {
        try {
          const store = pick();
          if (!store) return false;
          store.removeItem(key);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  const safeStorage = makeSafeStorage(() => global.localStorage);
  safeStorage.session = makeSafeStorage(() => global.sessionStorage);

  function normalizeDeg(value) {
    return ((value % 360) + 360) % 360;
  }

  function normalizeLng(value) {
    return ((value + 540) % 360) - 180;
  }

  function toMs(date) {
    if (date instanceof Date) return date.getTime();
    if (typeof date === 'number') return date;
    if (date == null) return Date.now();
    const parsed = new Date(date).getTime();
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  /**
   * Subsolar point (Earth-fixed lat/lng) from a low-precision solar ephemeris.
   * Good to a few arcminutes — far better than the terminator line is drawn.
   * Accepts a Date, an epoch-ms number, a parsable string, or nothing (= now).
   */
  function subsolar(date) {
    const jd = toMs(date) / 86400000 + 2440587.5;
    const d = jd - 2451545.0;
    const g = normalizeDeg(357.529 + 0.98560028 * d) * DEG;
    const q = normalizeDeg(280.459 + 0.98564736 * d);
    const lambda = normalizeDeg(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.00000036 * d) * DEG;
    const ra = normalizeDeg(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG);
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
    const gmstDeg = normalizeDeg(280.46061837 + 360.98564736629 * d);
    return { lat: dec, lng: normalizeLng(ra - gmstDeg) };
  }

  /**
   * lat/lng → Cartesian in three-globe's frame (Y up through the north pole,
   * Z out through 0°N 0°E). `r` defaults to 1, giving a unit direction vector.
   * Callers that need a THREE.Vector3 wrap the result themselves, so this file
   * stays free of any three.js dependency.
   */
  function latLngToVec3(lat, lng, r = 1) {
    const cosLat = Math.cos(lat * DEG);
    return {
      x: r * cosLat * Math.sin(lng * DEG),
      y: r * Math.sin(lat * DEG),
      z: r * cosLat * Math.cos(lng * DEG),
    };
  }

  global.CrucixCommon = {
    escapeHtml,
    safeExternalUrl,
    safeStorage,
    subsolar,
    latLngToVec3,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
