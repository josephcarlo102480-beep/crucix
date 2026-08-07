/**
 * sat-engine.js — orbital state for the Crucix satellite tracker.
 *
 * Owns everything that is not drawing: the catalogue, SGP4 propagation, the
 * simulation clock, illumination, ground tracks, pass prediction and
 * conjunction screening. Renderers read `sat.scene*` / `sat.lat,lng` and never
 * touch satellite.js themselves.
 *
 * Two deliberate choices:
 *
 * 1. Propagation is time-sliced across frames against a millisecond budget.
 *    A Pi cannot propagate 1500 objects inside one frame, but it can propagate
 *    a slice of them every frame — so the display moves continuously instead
 *    of jumping every 15 s like the old build.
 *
 * 2. Scene coordinates skip geodetic conversion entirely. ECI → ECF is one
 *    rotation about Z, and three-globe's frame is just ECF with the axes
 *    relabelled (scene = [y_ecf, z_ecf, x_ecf]), so a satellite's position
 *    costs one sin/cos shared across the whole batch. Latitude/longitude is
 *    computed only for the things that actually need it — the 2D map, the
 *    detail panel, passes and footprints.
 *
 * Global: window.SatEngine
 */
(function (global) {
  'use strict';

  const R_EARTH = 6378.137;      // km, equatorial — matches satellite.js
  const SCENE_RADIUS = 100;      // three-globe's fixed GLOBE_RADIUS
  const DEG = Math.PI / 180;

  // Altitude compression for the 3D view. At true scale the GEO belt sits
  // 6.6 Earth radii out and everything interesting is a dot in the middle;
  // sqrt compression keeps LEO roughly honest and pulls MEO/GEO into frame.
  //   LEO 400 km → 0.025 R   ·   GPS 20 200 km → 0.18 R   ·   GEO → 0.24 R
  function compressAlt(altKm) {
    return Math.sqrt(Math.max(0, altKm) / 6371) * 0.1;
  }

  // Elements this old propagate to nonsense.
  const MAX_ELEMENT_AGE_MS = 21 * 86400000;

  // --- simulation clock ------------------------------------------------
  // Anchored rather than accumulated so a dropped frame never loses time.
  let anchorReal = Date.now();
  let anchorSim = Date.now();
  let rate = 1;

  function simTimeMs() {
    return anchorSim + (Date.now() - anchorReal) * rate;
  }

  function setRate(next) {
    anchorSim = simTimeMs();
    anchorReal = Date.now();
    rate = Number.isFinite(next) ? next : 1;
  }

  function setOffsetSeconds(seconds) {
    anchorReal = Date.now();
    anchorSim = anchorReal + seconds * 1000;
  }

  function offsetSeconds() {
    return (simTimeMs() - Date.now()) / 1000;
  }

  // --- solar geometry --------------------------------------------------
  function normalizeDeg(v) { return ((v % 360) + 360) % 360; }

  /** Subsolar point (Earth-fixed lat/lng) — low-precision solar ephemeris. */
  function subsolar(ms) {
    const jd = ms / 86400000 + 2440587.5;
    const d = jd - 2451545.0;
    const g = normalizeDeg(357.529 + 0.98560028 * d) * DEG;
    const q = normalizeDeg(280.459 + 0.98564736 * d);
    const lambda = normalizeDeg(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.00000036 * d) * DEG;
    const ra = normalizeDeg(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG);
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
    const gmstDeg = normalizeDeg(280.46061837 + 360.98564736629 * d);
    return { lat: dec, lng: ((ra - gmstDeg + 540) % 360) - 180 };
  }

  /** Unit vector toward the Sun, Earth-fixed (ECF). */
  function sunVectorEcf(ms) {
    const s = subsolar(ms);
    const cl = Math.cos(s.lat * DEG);
    return { x: cl * Math.cos(s.lng * DEG), y: cl * Math.sin(s.lng * DEG), z: Math.sin(s.lat * DEG) };
  }

  /**
   * Cylindrical shadow test. A satellite is lit unless it sits behind Earth
   * along the Sun line and inside the terminator cylinder. The umbra is
   * conical rather than cylindrical, but the difference is a few seconds of
   * pass time — invisible at this scale.
   */
  function isSunlit(pos, sun) {
    const along = pos.x * sun.x + pos.y * sun.y + pos.z * sun.z;
    if (along >= 0) return true;
    const px = pos.x - along * sun.x;
    const py = pos.y - along * sun.y;
    const pz = pos.z - along * sun.z;
    return Math.sqrt(px * px + py * py + pz * pz) > R_EARTH;
  }

  // --- catalogue -------------------------------------------------------
  const groups = new Map();   // id -> { id, label, color, visible, sats, fetchedAt, stale, total }
  const sats = [];            // flat list of every loaded satellite
  const byKey = new Map();    // `${group}:${id}` -> sat

  const diag = { ok: 0, fail: 0, reasons: {} };

  function makeSat(rec, groupId, color) {
    let satrec;
    try {
      satrec = satellite.twoline2satrec(rec.line1, rec.line2);
    } catch { return null; }
    if (!satrec || satrec.error) return null;

    const epochMs = (satrec.jdsatepoch - 2440587.5) * 86400000;
    if (!Number.isFinite(epochMs) || Date.now() - epochMs > MAX_ELEMENT_AGE_MS) return null;

    const periodMin = (2 * Math.PI) / satrec.no;
    if (!Number.isFinite(periodMin) || periodMin <= 0) return null;

    return {
      key: `${groupId}:${rec.id}`,
      id: rec.id,
      name: rec.name,
      group: groupId,
      color,
      satrec,
      periodMin,
      epochMs,
      leo: periodMin < 128,
      // filled by propagation
      ok: false, eci: null, vel: null, speed: 0, altKm: 0,
      sceneX: 0, sceneY: 0, sceneZ: 0, sunlit: true,
      lat: 0, lng: 0, geoAt: 0,
      trail: null,
    };
  }

  async function loadGroup(groupId, opts = {}) {
    const url = `/api/tle/${encodeURIComponent(groupId)}`
      + (opts.limit ? `?limit=${opts.limit}` : '');
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    const color = body.color || '#64f0c8';
    const list = [];
    for (const rec of body.sats || []) {
      const sat = makeSat(rec, groupId, color);
      if (!sat || byKey.has(sat.key)) continue;
      byKey.set(sat.key, sat);
      list.push(sat);
      sats.push(sat);
    }

    const group = {
      id: groupId,
      label: body.label || groupId,
      color,
      visible: true,
      sats: list,
      fetchedAt: body.fetchedAt,
      stale: Boolean(body.stale),
      total: body.total || list.length,
    };
    groups.set(groupId, group);
    touch();
    return group;
  }

  function unloadGroup(groupId) {
    const group = groups.get(groupId);
    if (!group) return;
    for (const sat of group.sats) byKey.delete(sat.key);
    for (let i = sats.length - 1; i >= 0; i -= 1) {
      if (sats[i].group === groupId) sats.splice(i, 1);
    }
    groups.delete(groupId);
    touch();
  }

  /** Add one satellite outside any group — used by search results. */
  function addLoose(rec, groupId, color) {
    let group = groups.get(groupId);
    if (!group) {
      group = { id: groupId, label: 'Tracked', color, visible: true, sats: [], total: 0 };
      groups.set(groupId, group);
    }
    const existing = byKey.get(`${groupId}:${rec.id}`);
    if (existing) return existing;
    const sat = makeSat(rec, groupId, color);
    if (!sat) return null;
    byKey.set(sat.key, sat);
    group.sats.push(sat);
    group.total = group.sats.length;
    sats.push(sat);
    touch();
    return sat;
  }

  // The visible list is read every frame by the renderer, so it is cached and
  // only rebuilt when the catalogue actually changes. `version` doubles as
  // the renderer's "do I need to resync my buffers" signal.
  let version = 0;
  let visibleCache = [];
  let visibleCacheVersion = -1;

  function touch() { version += 1; }

  function visibleSats() {
    if (visibleCacheVersion === version) return visibleCache;
    const out = [];
    for (const sat of sats) {
      const group = groups.get(sat.group);
      if (group && group.visible) out.push(sat);
    }
    visibleCache = out;
    visibleCacheVersion = version;
    return out;
  }

  function setGroupVisible(groupId, visible) {
    const group = groups.get(groupId);
    if (!group || group.visible === visible) return;
    group.visible = visible;
    touch();
  }

  // --- propagation -----------------------------------------------------
  let cursor = 0;
  let scaleMode = 'compressed';   // 'compressed' | 'true'
  let lastSweepStart = 0;
  let lastSweepMs = 0;
  let sweepCount = 0;

  function fail(reason) {
    diag.fail += 1;
    diag.reasons[reason] = (diag.reasons[reason] || 0) + 1;
    return false;
  }

  /** ECI → scene, given precomputed cos/sin of GMST. */
  function toScene(sat, eci, cosG, sinG) {
    // ECI → ECF is a rotation of -GMST about Z.
    const xf = eci.x * cosG + eci.y * sinG;
    const yf = -eci.x * sinG + eci.y * cosG;
    const zf = eci.z;

    const r = Math.sqrt(xf * xf + yf * yf + zf * zf);
    if (!(r > 0)) return false;

    const altKm = r - R_EARTH;
    const displayR = scaleMode === 'true'
      ? SCENE_RADIUS * (r / R_EARTH)
      : SCENE_RADIUS * (1 + compressAlt(altKm));
    const k = displayR / r;

    // three-globe's frame is ECF with axes relabelled.
    sat.sceneX = yf * k;
    sat.sceneY = zf * k;
    sat.sceneZ = xf * k;
    sat.ecf = { x: xf, y: yf, z: zf };
    sat.altKm = altKm;
    return true;
  }

  function propagateOne(sat, time, gmst, cosG, sinG, sun) {
    let pv;
    try {
      pv = satellite.propagate(sat.satrec, time);
    } catch {
      sat.ok = false;
      return fail('exception');
    }
    if (!pv || !pv.position || typeof pv.position === 'boolean' || sat.satrec.error !== 0) {
      sat.ok = false;
      return fail('no_position');
    }
    const p = pv.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      sat.ok = false;
      return fail('eci_nan');
    }

    const v = pv.velocity || { x: 0, y: 0, z: 0 };
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    // Escape velocity at the surface is 11.2 km/s; above that the elements
    // are producing hyperbolic nonsense.
    if (speed > 11.2) { sat.ok = false; return fail('escape_vel'); }

    sat.eci = p;
    sat.vel = v;
    sat.speed = speed;
    sat.gmst = gmst;

    if (!toScene(sat, p, cosG, sinG)) { sat.ok = false; return fail('scene_nan'); }
    // Below the Kármán line it has decayed; past Molniya apogee it is garbage.
    if (sat.altKm < 80 || sat.altKm > 60000) { sat.ok = false; return fail('bad_alt'); }

    sat.sunlit = isSunlit(sat.ecf, sun);
    sat.ok = true;
    sat.geoAt = 0; // invalidate any cached lat/lng
    diag.ok += 1;
    return true;
  }

  /**
   * Propagate as many satellites as fit in `budgetMs`, resuming where the
   * previous frame stopped. Returns true when a full sweep just completed.
   */
  function step(budgetMs) {
    const list = visibleSats();
    if (!list.length) { cursor = 0; return false; }

    const ms = simTimeMs();
    const time = new Date(ms);
    const gmst = satellite.gstime(time);
    const cosG = Math.cos(gmst);
    const sinG = Math.sin(gmst);
    const sun = sunVectorEcf(ms);

    // A group being hidden mid-sweep can leave the cursor past the end.
    if (cursor >= list.length) cursor = 0;
    if (cursor === 0) lastSweepStart = performance.now();

    const deadline = performance.now() + budgetMs;
    let done = false;
    // Check the clock every 32 objects — performance.now() is not free.
    while (cursor < list.length) {
      const end = Math.min(list.length, cursor + 32);
      for (; cursor < end; cursor += 1) {
        propagateOne(list[cursor], time, gmst, cosG, sinG, sun);
      }
      if (performance.now() > deadline) break;
    }
    if (cursor >= list.length) {
      cursor = 0;
      done = true;
      lastSweepMs = performance.now() - lastSweepStart;
      sweepCount += 1;
    }
    return done;
  }

  /** Force every visible satellite up to date now, ignoring the frame budget. */
  function stepAll() {
    cursor = 0;
    step(Infinity);
  }

  // --- derived geometry ------------------------------------------------
  /** Geodetic position, computed on demand and cached for this propagation. */
  function geodetic(sat) {
    if (!sat.ok || !sat.eci) return null;
    if (sat.geoAt === sat.gmst) return sat;
    try {
      const gd = satellite.eciToGeodetic(sat.eci, sat.gmst);
      const lat = satellite.degreesLat(gd.latitude);
      const lng = satellite.degreesLong(gd.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      sat.lat = lat;
      sat.lng = lng;
      sat.geoAt = sat.gmst;
      return sat;
    } catch {
      return null;
    }
  }

  /**
   * Trailing arc behind a satellite, as scene-space vertices.
   *
   * Rather than re-running SGP4 for every trail vertex (which would multiply
   * the propagation bill by the trail length), the position vector is rotated
   * backwards about the orbit normal at the instantaneous angular rate. That
   * is exact for a circular orbit and indistinguishable from truth over the
   * couple of minutes a trail covers.
   */
  function trailPoints(sat, count, spanSeconds) {
    if (!sat.ok || !sat.eci || !sat.vel) return null;
    const r = sat.eci;
    const v = sat.vel;

    // h = r × v gives the orbit normal; |h|/|r|² is the angular rate.
    const hx = r.y * v.z - r.z * v.y;
    const hy = r.z * v.x - r.x * v.z;
    const hz = r.x * v.y - r.y * v.x;
    const hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const rMag = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    if (!(hMag > 0) || !(rMag > 0)) return null;

    const nx = hx / hMag, ny = hy / hMag, nz = hz / hMag;
    const omega = hMag / (rMag * rMag); // rad/s
    const out = new Float32Array(count * 3);
    const scratch = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < count; i += 1) {
      const dt = (spanSeconds * i) / (count - 1);       // seconds into the past
      const a = -omega * dt;
      const c = Math.cos(a), s = Math.sin(a);
      // Rodrigues rotation of r about n by angle a.
      const dot = nx * r.x + ny * r.y + nz * r.z;
      const cx = ny * r.z - nz * r.y;
      const cy = nz * r.x - nx * r.z;
      const cz = nx * r.y - ny * r.x;
      scratch.x = r.x * c + cx * s + nx * dot * (1 - c);
      scratch.y = r.y * c + cy * s + ny * dot * (1 - c);
      scratch.z = r.z * c + cz * s + nz * dot * (1 - c);

      // Earth has rotated too — use GMST at that instant, not now.
      const g = sat.gmst - 7.292115e-5 * dt;
      const cg = Math.cos(g), sg = Math.sin(g);
      const tmp = { x: scratch.x, y: scratch.y, z: scratch.z };
      const xf = tmp.x * cg + tmp.y * sg;
      const yf = -tmp.x * sg + tmp.y * cg;
      const zf = tmp.z;
      const rr = Math.sqrt(xf * xf + yf * yf + zf * zf);
      const displayR = scaleMode === 'true'
        ? SCENE_RADIUS * (rr / R_EARTH)
        : SCENE_RADIUS * (1 + compressAlt(rr - R_EARTH));
      const k = displayR / rr;
      out[i * 3] = yf * k;
      out[i * 3 + 1] = zf * k;
      out[i * 3 + 2] = xf * k;
    }
    return out;
  }

  /** One full revolution as [lat,lng,altFraction] triples, for path rendering. */
  function orbitPath(sat, steps = 180) {
    if (!sat.satrec) return [];
    const nowMs = simTimeMs();
    const stepMs = (sat.periodMin * 60000) / steps;
    const out = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = new Date(nowMs + (i - steps / 2) * stepMs);
      try {
        const pv = satellite.propagate(sat.satrec, t);
        if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
        const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
        const lat = satellite.degreesLat(gd.latitude);
        const lng = satellite.degreesLong(gd.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(gd.height)) continue;
        out.push([lat, lng, gd.height]);
      } catch { /* skip */ }
    }
    return out;
  }

  /** Ground track only (no altitude), split at the antimeridian for Leaflet. */
  function groundTrack(sat, minutesBack, minutesFwd, stepSeconds) {
    if (!sat.satrec) return [];
    const nowMs = simTimeMs();
    const pts = [];
    for (let s = -minutesBack * 60; s <= minutesFwd * 60; s += stepSeconds) {
      const t = new Date(nowMs + s * 1000);
      try {
        const pv = satellite.propagate(sat.satrec, t);
        if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
        const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
        const lat = satellite.degreesLat(gd.latitude);
        const lng = satellite.degreesLong(gd.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        pts.push({ lat, lng, future: s >= 0 });
      } catch { /* skip */ }
    }

    const segments = [];
    let current = [];
    let currentFuture = pts.length ? pts[0].future : true;
    for (let i = 0; i < pts.length; i += 1) {
      const prev = pts[i - 1];
      const jump = prev && (Math.abs(pts[i].lng - prev.lng) > 90 || Math.abs(pts[i].lat - prev.lat) > 20);
      if (jump || (prev && pts[i].future !== currentFuture)) {
        if (current.length > 1) segments.push({ future: currentFuture, coords: current });
        // Keep the boundary point so past and future tracks meet.
        current = jump ? [] : [[prev.lat, prev.lng]];
        currentFuture = pts[i].future;
      }
      current.push([pts[i].lat, pts[i].lng]);
    }
    if (current.length > 1) segments.push({ future: currentFuture, coords: current });
    return segments;
  }

  /**
   * Radius on the ground, in metres, of the circle from which the satellite
   * is above the horizon. Pure geometry: cos(central angle) = Re / (Re + h).
   */
  function footprintRadiusM(altKm) {
    const central = Math.acos(R_EARTH / (R_EARTH + Math.max(1, altKm)));
    return central * R_EARTH * 1000;
  }

  // --- observer look angles, passes, visibility -------------------------
  let observer = { lat: 0, lng: 0, height: 0.01 };
  let observerGd = null;

  function setObserver(lat, lng, heightKm = 0.01) {
    observer = { lat, lng, height: heightKm };
    observerGd = { longitude: lng * DEG, latitude: lat * DEG, height: heightKm };
  }

  function lookAngles(satrec, time) {
    try {
      const pv = satellite.propagate(satrec, time);
      if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
      const gmst = satellite.gstime(time);
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const look = satellite.ecfToLookAngles(observerGd, ecf);
      const az = (look.azimuth / DEG + 360) % 360;
      const el = look.elevation / DEG;
      if (!Number.isFinite(az) || !Number.isFinite(el)) return null;
      return { az, el, rangeKm: look.rangeSat, eci: pv.position, gmst };
    } catch {
      return null;
    }
  }

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function bearing(az) { return COMPASS[Math.round(((az % 360) + 360) % 360 / 22.5) % 16]; }

  /** Sun elevation at the observer — below −6° is when satellites become visible. */
  function sunElevation(ms) {
    const s = subsolar(ms);
    const dLng = (observer.lng - s.lng) * DEG;
    const sinEl = Math.sin(observer.lat * DEG) * Math.sin(s.lat * DEG)
      + Math.cos(observer.lat * DEG) * Math.cos(s.lat * DEG) * Math.cos(dLng);
    return Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
  }

  /**
   * Predict passes over the observer.
   *
   * Coarse-steps at `stepSec`, then bisects the horizon crossings so rise and
   * set times are good to a second rather than to the sample grid. Non-LEO
   * objects are skipped: a GEO satellite is either always up or never up,
   * which is not a "pass".
   *
   * A 12 h search costs ~720 propagations per satellite, so the candidate
   * list is capped and the loop yields between satellites — otherwise
   * selecting Starlink would lock the tab for the best part of a minute.
   */
  let passRunId = 0;
  async function computePasses(hoursAhead = 12, opts = {}) {
    const runId = ++passRunId;
    if (!observerGd) return { passes: [], considered: 0, truncated: 0 };

    const stepSec = opts.stepSec || 60;
    const minPeak = opts.minPeakEl != null ? opts.minPeakEl : 10;
    const startMs = opts.fromMs || simTimeMs();
    const maxSats = opts.maxSats || 120;

    const candidates = (opts.sats || visibleSats()).filter((s) => s.leo && s.ok !== false);
    // Small hand-picked groups are what people actually watch for; a 600-strong
    // constellation gets sampled rather than searched exhaustively.
    candidates.sort((a, b) => {
      const rank = (s) => (groups.get(s.group)?.sats.length || 1);
      return rank(a) - rank(b);
    });
    const list = candidates.slice(0, maxSats);
    const truncated = candidates.length - list.length;
    const passes = [];

    for (let s = 0; s < list.length; s += 1) {
      if (runId !== passRunId) return null;
      if (s % 8 === 7) await new Promise((r) => setTimeout(r, 0));

      const sat = list[s];
      let inPass = false;
      let peakEl = -90, peakMs = 0, peakAz = 0;
      let riseMs = 0, riseAz = 0;
      let prevMs = 0;

      for (let t = 0; t <= hoursAhead * 3600; t += stepSec) {
        const ms = startMs + t * 1000;
        const look = lookAngles(sat.satrec, new Date(ms));
        if (!look) continue;

        if (look.el > 0 && !inPass) {
          inPass = true;
          peakEl = -90;
          // Already up on the first sample — there is no crossing to refine.
          const crossing = prevMs ? refineCrossing(sat.satrec, prevMs, ms) : { ms, az: look.az };
          riseMs = crossing.ms;
          riseAz = crossing.az;
        }
        if (inPass && look.el > peakEl) {
          peakEl = look.el; peakMs = ms; peakAz = look.az;
        }
        if (look.el <= 0 && inPass) {
          inPass = false;
          const crossing = refineCrossing(sat.satrec, ms, prevMs);
          if (peakEl >= minPeak) {
            passes.push(buildPass(sat, riseMs, riseAz, crossing.ms, crossing.az, peakMs, peakEl, peakAz));
          }
        }
        prevMs = ms;
      }
      if (inPass && peakEl >= minPeak) {
        passes.push(buildPass(sat, riseMs, riseAz, null, null, peakMs, peakEl, peakAz));
      }
    }

    passes.sort((a, b) => a.peakMs - b.peakMs);
    return { passes, considered: list.length, truncated };
  }

  /**
   * Bisect a horizon crossing. `belowMs` and `aboveMs` bracket it; which one
   * is earlier depends on whether this is a rise or a set.
   */
  function refineCrossing(satrec, belowMs, aboveMs) {
    let below = belowMs, above = aboveMs;
    for (let i = 0; i < 14 && Math.abs(above - below) > 500; i += 1) {
      const mid = (below + above) / 2;
      const m = lookAngles(satrec, new Date(mid));
      if (!m) break;
      if (m.el > 0) above = mid; else below = mid;
    }
    const at = (below + above) / 2;
    const look = lookAngles(satrec, new Date(at));
    return { ms: at, az: look ? look.az : 0 };
  }

  function buildPass(sat, riseMs, riseAz, setMs, setAz, peakMs, peakEl, peakAz) {
    // Sunlit at peak with the observer in twilight or darkness means the pass
    // is actually visible to the eye, not merely geometrically overhead.
    const sunEl = sunElevation(peakMs);
    const pv = safePropagate(sat.satrec, new Date(peakMs));
    let lit = false;
    if (pv) {
      const gmst = satellite.gstime(new Date(peakMs));
      const ecf = satellite.eciToEcf(pv.position, gmst);
      lit = isSunlit(ecf, sunVectorEcf(peakMs));
    }
    return {
      key: sat.key,
      name: sat.name,
      id: sat.id,
      group: sat.group,
      color: sat.color,
      riseMs, riseAz, setMs, setAz, peakMs, peakEl, peakAz,
      durationS: setMs ? Math.round((setMs - riseMs) / 1000) : null,
      bearing: bearing(peakAz),
      riseBearing: bearing(riseAz),
      setBearing: setAz == null ? null : bearing(setAz),
      sunlit: lit,
      observerDark: sunEl < -6,
      visible: lit && sunEl < -6,
    };
  }

  function safePropagate(satrec, time) {
    try {
      const pv = satellite.propagate(satrec, time);
      if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
      return pv;
    } catch { return null; }
  }

  /** Az/el samples across a pass, for the polar sky plot. */
  function passTrack(satKey, pass, samples = 48) {
    const sat = byKey.get(satKey);
    if (!sat || !pass || !pass.setMs) return [];
    const out = [];
    for (let i = 0; i <= samples; i += 1) {
      const ms = pass.riseMs + ((pass.setMs - pass.riseMs) * i) / samples;
      const look = lookAngles(sat.satrec, new Date(ms));
      if (look && look.el >= 0) out.push({ az: look.az, el: look.el, ms });
    }
    return out;
  }

  /**
   * Everything currently above the horizon, highest first. Reuses the ECI
   * vectors the propagation sweep already produced instead of re-running
   * SGP4, so this is cheap enough to call on a timer.
   */
  function overhead(minEl = 0) {
    if (!observerGd) return [];
    const out = [];
    for (const sat of visibleSats()) {
      if (!sat.ok || !sat.eci) continue;
      try {
        const ecf = satellite.eciToEcf(sat.eci, sat.gmst);
        const look = satellite.ecfToLookAngles(observerGd, ecf);
        const el = look.elevation / DEG;
        if (!Number.isFinite(el) || el < minEl) continue;
        out.push({
          sat,
          el,
          az: (look.azimuth / DEG + 360) % 360,
          rangeKm: look.rangeSat,
          bearing: bearing((look.azimuth / DEG + 360) % 360),
        });
      } catch { /* skip */ }
    }
    out.sort((a, b) => b.el - a.el);
    return out;
  }

  // --- conjunctions -----------------------------------------------------
  // LEO-LEO closing speeds reach ~15 km/s, so between 30 s coarse samples a
  // pair can close by ~±225 km — CAPTURE_KM must cover that for the refine
  // pass to find the true minimum near any coarse dip.
  const CONJ = {
    coarseStepS: 30,
    thresholdKm: 50,
    captureKm: 300,
    bandMarginKm: 30,
    coorbitWindowS: 1200,  // how far either side of closest approach to re-check
    coorbitKm: 60,         // still this close 20 min later ⇒ docked, not a conjunction
  };
  let conjRunId = 0;

  function orbitalRadiusBand(satrec) {
    const MU = 398600.4418;
    const n = satrec.no / 60;
    const a = Math.cbrt(MU / (n * n));
    return { rp: a * (1 - satrec.ecco), ra: a * (1 + satrec.ecco) };
  }

  function eciDistance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Screen every visible pair for close approaches over `hours`.
   * Yields to the event loop regularly, and bails out if a newer run started.
   */
  async function computeConjunctions(hours = 12, onProgress) {
    const runId = ++conjRunId;
    const list = visibleSats();
    if (list.length < 2) return { conjunctions: [], pairs: 0, sats: list.length };

    // Orbit shells that never overlap cannot produce a conjunction — this
    // drops nearly every cross-constellation pair before any propagation.
    const bands = list.map((s) => orbitalRadiusBand(s.satrec));
    const pairs = [];
    const involved = new Uint8Array(list.length);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const gap = Math.max(bands[i].rp, bands[j].rp) - Math.min(bands[i].ra, bands[j].ra);
        if (gap > CONJ.thresholdKm + CONJ.bandMarginKm) continue;
        pairs.push([i, j]);
        involved[i] = 1; involved[j] = 1;
      }
    }
    if (!pairs.length) return { conjunctions: [], pairs: 0, sats: list.length };

    const startMs = simTimeMs();
    const steps = Math.floor((hours * 3600) / CONJ.coarseStepS);
    const best = new Map();
    const pos = new Array(list.length).fill(null);

    for (let s = 0; s <= steps; s += 1) {
      if (runId !== conjRunId) return null;
      const time = new Date(startMs + s * CONJ.coarseStepS * 1000);
      for (let i = 0; i < list.length; i += 1) {
        pos[i] = involved[i] ? (safePropagate(list[i].satrec, time)?.position || null) : null;
      }
      for (let k = 0; k < pairs.length; k += 1) {
        const [i, j] = pairs[k];
        if (!pos[i] || !pos[j]) continue;
        const d = eciDistance(pos[i], pos[j]);
        if (d < CONJ.captureKm) {
          const prev = best.get(k);
          if (!prev || d < prev.d) best.set(k, { d, ms: time.getTime() });
        }
      }
      if (s % 40 === 39) {
        if (onProgress) onProgress(s / steps, pairs.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Refine each coarse dip at 1 s, then fit a parabola through the minimum
    // so the reported distance is the real closest approach rather than
    // whatever separation happened to land on a sample instant.
    const out = [];
    let processed = 0;
    let coorbiting = 0;
    for (const [k, coarse] of best) {
      if (runId !== conjRunId) return null;
      if ((processed += 1) % 20 === 0) await new Promise((r) => setTimeout(r, 0));

      const [i, j] = pairs[k];
      const window = CONJ.coarseStepS * 1000;
      const samples = new Map();
      let minD = Infinity, minMs = coarse.ms;
      for (let t = coarse.ms - window; t <= coarse.ms + window; t += 1000) {
        const a = safePropagate(list[i].satrec, new Date(t))?.position;
        const b = safePropagate(list[j].satrec, new Date(t))?.position;
        if (!a || !b) continue;
        const d = eciDistance(a, b);
        samples.set(t, d);
        if (d < minD) { minD = d; minMs = t; }
      }
      if (!Number.isFinite(minD)) continue;

      const d0 = samples.get(minMs - 1000), d2 = samples.get(minMs + 1000);
      if (d0 !== undefined && d2 !== undefined) {
        const denom = d0 - 2 * minD + d2;
        if (denom > 1e-9) {
          const frac = 0.5 * (d0 - d2) / denom;
          const vertex = minD - ((d0 - d2) * (d0 - d2)) / (8 * denom);
          if (Math.abs(frac) <= 1 && vertex >= 0) { minMs += frac * 1000; minD = vertex; }
        }
      }
      if (minD > CONJ.thresholdKm) continue;

      // Docked and formation-flying objects — station modules, a Progress on
      // the ISS, the CSS stack — sit at zero separation permanently and would
      // otherwise fill the list with fake CRITICALs. A real conjunction has a
      // large relative velocity, so the pair is thousands of km apart twenty
      // minutes either side of closest approach; a docked pair is not.
      const away = CONJ.coorbitWindowS * 1000;
      const separationAt = (t) => {
        const pa = safePropagate(list[i].satrec, new Date(t))?.position;
        const pb = safePropagate(list[j].satrec, new Date(t))?.position;
        return pa && pb ? eciDistance(pa, pb) : Infinity;
      };
      if (separationAt(minMs - away) < CONJ.coorbitKm
        && separationAt(minMs + away) < CONJ.coorbitKm) {
        coorbiting += 1;
        continue;
      }

      const time = new Date(minMs);
      const gmst = satellite.gstime(time);
      const geo = (satrec) => {
        const pv = safePropagate(satrec, time);
        if (!pv) return null;
        const gd = satellite.eciToGeodetic(pv.position, gmst);
        return {
          lat: satellite.degreesLat(gd.latitude),
          lng: satellite.degreesLong(gd.longitude),
          alt: gd.height,
        };
      };
      const a = geo(list[i].satrec);
      const b = geo(list[j].satrec);
      if (!a || !b) continue;

      let midLng = (a.lng + b.lng) / 2;
      if (Math.abs(a.lng - b.lng) > 180) midLng = ((midLng + 360) % 360) - 180;

      const severity = minD < 10 ? 'critical' : minD < 25 ? 'warning' : 'watch';
      out.push({
        a: list[i], b: list[j],
        nameA: list[i].name, nameB: list[j].name,
        minDistKm: minD, ms: minMs,
        latA: a.lat, lngA: a.lng, altA: a.alt,
        latB: b.lat, lngB: b.lng, altB: b.alt,
        midLat: (a.lat + b.lat) / 2, midLng,
        severity,
      });
    }

    out.sort((x, y) => x.minDistKm - y.minDistKm);
    return { conjunctions: out, pairs: pairs.length, sats: list.length, coorbiting };
  }

  global.SatEngine = {
    R_EARTH,
    SCENE_RADIUS,
    compressAlt,
    // clock
    simTimeMs, setRate, setOffsetSeconds, offsetSeconds,
    get rate() { return rate; },
    // catalogue
    groups, sats, byKey, loadGroup, unloadGroup, addLoose, visibleSats,
    setGroupVisible,
    get version() { return version; },
    // propagation
    step, stepAll,
    get scaleMode() { return scaleMode; },
    set scaleMode(v) { scaleMode = v === 'true' ? 'true' : 'compressed'; },
    // derived
    geodetic, trailPoints, orbitPath, groundTrack, footprintRadiusM,
    // sun
    subsolar, sunVectorEcf, sunElevation, isSunlit,
    // observer
    setObserver, get observer() { return observer; }, lookAngles, bearing,
    computePasses, passTrack, overhead,
    // conjunctions
    computeConjunctions, CONJ,
    // diagnostics
    diag,
    stats() {
      return { sweepMs: Math.round(lastSweepMs), sweeps: sweepCount, cursor, tracked: visibleSats().length };
    },
  };
})(window);
