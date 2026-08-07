/**
 * sat-globe3d.js — 3D rendering for the Crucix satellite tracker.
 *
 * Replaces the old one-DOM-node-per-satellite approach, which topped out at a
 * few dozen objects. Everything here is GPU-side:
 *
 *   · the Earth is a single shader that blends the daytime image against the
 *     city-lights image across a real terminator, with relief and ocean glint;
 *   · every satellite is one vertex in one THREE.Points draw call, shaded by
 *     whether it is in sunlight or in Earth's shadow;
 *   · trails are one THREE.LineSegments draw call for the whole constellation.
 *
 * That leaves Globe.gl's own layers (paths, rings, HTML labels) for the small
 * number of things attached to the *selected* satellite, where they are cheap.
 *
 * Global: window.SatGlobe3D
 */
(function (global) {
  'use strict';

  const TEXTURES = 'https://unpkg.com/three-globe/example/img/';
  const SCENE_RADIUS = 100;
  const DEG = Math.PI / 180;
  const TRAIL_POINTS = 10;

  const GLOBE_VERT = `
    varying vec2 vUv;
    varying vec3 vNormalW;
    varying vec3 vWorldPos;
    void main() {
      vUv = uv;
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPos = world.xyz;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `;

  const GLOBE_FRAG = `
    uniform sampler2D uDay;
    uniform sampler2D uNight;
    uniform sampler2D uTopo;
    uniform vec3 uSun;
    uniform float uNightLights;
    uniform float uRelief;
    uniform float uGlint;
    varying vec2 vUv;
    varying vec3 vNormalW;
    varying vec3 vWorldPos;

    void main() {
      vec3 n = normalize(vNormalW);
      float c = dot(n, uSun);

      // Civil twilight is about 1 degree of arc wide; widening it to a few
      // degrees is a deliberate cheat — a mathematically sharp terminator
      // reads as an aliasing artefact at globe scale.
      float day = smoothstep(-0.10, 0.18, c);

      vec3 dayCol = texture2D(uDay, vUv).rgb;
      vec3 nightCol = texture2D(uNight, vUv).rgb;

      // Fake relief from the topology map's local gradient. Cheap, and enough
      // to stop the day side reading as a flat decal.
      float relief = 1.0;
      if (uRelief > 0.5) {
        float e = 0.0015;
        float h = texture2D(uTopo, vUv).r;
        float hx = texture2D(uTopo, vUv + vec2(e, 0.0)).r - h;
        float hy = texture2D(uTopo, vUv + vec2(0.0, e)).r - h;
        relief = clamp(1.0 + (hx + hy) * 6.0, 0.72, 1.30);
      }

      // Ocean glint. Water is where the image is markedly bluer than it is
      // red, which saves downloading a separate specular mask.
      float water = smoothstep(0.02, 0.20, dayCol.b - dayCol.r);
      vec3 view = normalize(cameraPosition - vWorldPos);
      vec3 halfV = normalize(uSun + view);
      float spec = pow(max(dot(n, halfV), 0.0), 48.0) * water * day * uGlint;

      // Warm scattering band where the sun is on the horizon. Kept narrow and
      // faint on purpose: the night side is nearly black, so anything wider
      // than the real twilight arc washes half the planet orange.
      float terminator = exp(-pow(c * 8.0, 2.0));
      vec3 warm = vec3(1.0, 0.44, 0.18) * terminator * 0.13;

      // The night image carries a lit ocean as well as city lights. Weighting
      // by luminance keeps the cities bright and holds the water back to a
      // faint moonlit wash, instead of turning every sea into a blue lamp.
      // Thresholds come from the texture itself: open ocean sits near 0.005
      // linear luminance, lit conurbations near 0.13.
      float lum = dot(nightCol, vec3(0.4, 0.5, 0.1));
      float cities = 0.05 + 0.95 * smoothstep(0.012, 0.09, lum);

      // Night ambient is deliberately near zero — city lights should be the
      // only thing carrying the dark side.
      vec3 col = dayCol * relief * (0.018 + 1.02 * day);
      col += nightCol * cities * pow(1.0 - day, 1.4) * uNightLights;
      col += warm;
      col += spec * vec3(1.0, 0.95, 0.85);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const POINT_VERT = `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aLit;
    attribute float aSel;
    uniform float uPixelRatio;
    uniform float uScale;
    varying vec3 vColor;
    varying float vLit;
    varying float vSel;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vColor = aColor;
      vLit = aLit;
      vSel = aSel;
      float dist = max(1.0, -mv.z);
      // Clamped tightly: satellites are points of light, and letting them
      // scale freely turns a close fly-in into a screen full of blobs.
      gl_PointSize = aSize * uPixelRatio * clamp(uScale / dist, 0.6, 1.55) * (1.0 + aSel * 0.55);
      gl_Position = projectionMatrix * mv;
    }
  `;

  const POINT_FRAG = `
    varying vec3 vColor;
    varying float vLit;
    varying float vSel;
    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = length(d);
      if (r > 0.5) discard;
      float core = 1.0 - smoothstep(0.0, 0.20, r);
      float halo = 1.0 - smoothstep(0.14, 0.50, r);
      // An object in Earth's shadow is not visible from the ground, so it is
      // drawn as a dim ghost rather than hidden outright.
      vec3 col = mix(vColor * 0.40, vColor, vLit);
      col = mix(col, vec3(1.0), vSel * 0.6);
      float a = (core * 0.95 + halo * 0.40) * mix(0.5, 1.0, vLit);
      a = clamp(a + vSel * 0.4, 0.0, 1.0);
      gl_FragColor = vec4(col, a);
    }
  `;

  const TRAIL_VERT = `
    attribute vec3 aColor;
    attribute float aFade;
    varying vec3 vColor;
    varying float vFade;
    void main() {
      vColor = aColor;
      vFade = aFade;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const TRAIL_FRAG = `
    varying vec3 vColor;
    varying float vFade;
    uniform float uOpacity;
    void main() {
      gl_FragColor = vec4(vColor, vFade * uOpacity);
    }
  `;

  function hexToRgb(hex) {
    const c = new THREE.Color(hex || '#ffffff');
    return [c.r, c.g, c.b];
  }

  function latLngToVec3(lat, lng) {
    const cl = Math.cos(lat * DEG);
    return new THREE.Vector3(cl * Math.sin(lng * DEG), Math.sin(lat * DEG), cl * Math.cos(lng * DEG));
  }

  function create(container, opts = {}) {
    const engine = global.SatEngine;
    const state = {
      globe: null,
      fx: null,
      points: null,
      trails: null,
      capacity: 0,
      rendered: [],          // sats in the same order as the point buffer
      selected: null,
      hovered: null,
      showTrails: true,
      trailBudget: 1300,     // above this many objects trails are dropped
      catalogueVersion: -1,
      onSelect: opts.onSelect || (() => {}),
      onHover: opts.onHover || (() => {}),
      frame: 0,
      fps: 0,
      lastFpsAt: performance.now(),
      framesSince: 0,
    };

    // --- Globe.gl scaffolding -----------------------------------------
    const globe = Globe()(container)
      .backgroundColor('rgba(0,0,0,0)')
      .backgroundImageUrl('')
      .showAtmosphere(false)
      .pointOfView({ lat: opts.lat || 20, lng: opts.lng || 0, altitude: 2.3 })
      // Orbit and footprint for the selected satellite only — one or two
      // paths, so Globe.gl's own line rendering is fine here.
      .pathsData([])
      .pathPoints((d) => d.coords)
      .pathPointLat((p) => p[0])
      .pathPointLng((p) => p[1])
      .pathPointAlt((p) => p[2])
      .pathColor((d) => d.color)
      .pathStroke((d) => d.stroke || null)
      .pathTransitionDuration(0)
      .ringsData([])
      .ringLat('lat').ringLng('lng')
      .ringColor((d) => d.color)
      .ringMaxRadius((d) => d.maxRadius)
      .ringPropagationSpeed((d) => d.speed)
      .ringRepeatPeriod((d) => d.period);

    state.globe = globe;
    const scene = globe.scene();
    const renderer = globe.renderer();

    globe.controls().autoRotate = opts.autoRotate !== false;
    globe.controls().autoRotateSpeed = 0.18;
    globe.controls().minDistance = SCENE_RADIUS * 1.08;
    globe.controls().maxDistance = SCENE_RADIUS * 12;

    // --- Earth material ------------------------------------------------
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const load = (file) => new Promise((resolve) => {
      loader.load(TEXTURES + file, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        resolve(tex);
      }, undefined, () => resolve(null));
    });

    const sunDirection = new THREE.Vector3(1, 0, 0);
    const earthUniforms = {
      uDay: { value: null },
      uNight: { value: null },
      uTopo: { value: null },
      uSun: { value: sunDirection },
      uNightLights: { value: 7.5 },
      uRelief: { value: 1 },
      uGlint: { value: 0.55 },
    };

    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: earthUniforms,
      vertexShader: GLOBE_VERT,
      fragmentShader: GLOBE_FRAG,
    });

    Promise.all([load('earth-blue-marble.jpg'), load('earth-night.jpg'), load('earth-topology.png')])
      .then(([day, night, topo]) => {
        if (!day) {
          // No imagery reached us — fall back to Globe.gl's own handling so
          // the page still shows a planet rather than a black sphere.
          globe.globeImageUrl(TEXTURES + 'earth-blue-marble.jpg');
          return;
        }
        earthUniforms.uDay.value = day;
        earthUniforms.uNight.value = night || day;
        earthUniforms.uTopo.value = topo || day;
        earthUniforms.uNightLights.value = night ? 7.5 : 0;
        earthUniforms.uRelief.value = topo ? 1 : 0;
        globe.globeMaterial(earthMaterial);
      });

    function updateSun() {
      const s = engine.subsolar(engine.simTimeMs());
      sunDirection.copy(latLngToVec3(s.lat, s.lng));
    }
    updateSun();

    // --- satellite point cloud -----------------------------------------
    const pointUniforms = {
      uPixelRatio: { value: renderer.getPixelRatio() },
      uScale: { value: 260 },
    };
    const pointMaterial = new THREE.ShaderMaterial({
      uniforms: pointUniforms,
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });

    const trailUniforms = { uOpacity: { value: 0.42 } };
    const trailMaterial = new THREE.ShaderMaterial({
      uniforms: trailUniforms,
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    function allocate(capacity) {
      if (state.points) {
        scene.remove(state.points);
        state.points.geometry.dispose();
      }
      if (state.trails) {
        scene.remove(state.trails);
        state.trails.geometry.dispose();
      }

      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
      pg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
      pg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(capacity), 1));
      pg.setAttribute('aLit', new THREE.BufferAttribute(new Float32Array(capacity), 1));
      pg.setAttribute('aSel', new THREE.BufferAttribute(new Float32Array(capacity), 1));
      pg.setDrawRange(0, 0);
      const points = new THREE.Points(pg, pointMaterial);
      points.frustumCulled = false;
      points.renderOrder = 12;
      points.name = 'CrucixSats';
      scene.add(points);
      state.points = points;

      // Two vertices per segment, TRAIL_POINTS-1 segments per satellite.
      const segVerts = capacity * (TRAIL_POINTS - 1) * 2;
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segVerts * 3), 3));
      tg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(segVerts * 3), 3));
      tg.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(segVerts), 1));
      tg.setDrawRange(0, 0);
      const trails = new THREE.LineSegments(tg, trailMaterial);
      trails.frustumCulled = false;
      trails.renderOrder = 11;
      trails.name = 'CrucixSatTrails';
      scene.add(trails);
      state.trails = trails;

      state.capacity = capacity;
      // The per-frame hook rides on the point cloud: it is never culled, so
      // its onBeforeRender fires once per frame for free.
      points.onBeforeRender = tick;
    }

    allocate(256);

    /** Re-read the catalogue: sizes and colours only change when it changes. */
    function syncCatalogue() {
      const list = engine.visibleSats();
      state.catalogueVersion = engine.version;
      if (list.length > state.capacity) {
        allocate(Math.max(list.length + 128, state.capacity * 2));
      }
      state.rendered = list;

      const colors = state.points.geometry.getAttribute('aColor');
      const sizes = state.points.geometry.getAttribute('aSize');
      for (let i = 0; i < list.length; i += 1) {
        const rgb = list[i].rgb || (list[i].rgb = hexToRgb(list[i].color));
        colors.array[i * 3] = rgb[0];
        colors.array[i * 3 + 1] = rgb[1];
        colors.array[i * 3 + 2] = rgb[2];
        // Manned stations deserve to stand out from a 600-strong shell.
        sizes.array[i] = list[i].group === 'stations' ? 12 : 6.5;
      }
      colors.needsUpdate = true;
      sizes.needsUpdate = true;
      state.points.geometry.setDrawRange(0, list.length);
      rebuildTrails();
    }

    function writePositions() {
      const list = state.rendered;
      const geom = state.points.geometry;
      const pos = geom.getAttribute('position');
      const lit = geom.getAttribute('aLit');
      const sel = geom.getAttribute('aSel');

      for (let i = 0; i < list.length; i += 1) {
        const sat = list[i];
        if (!sat.ok) {
          // Park failed propagations at the origin, inside the Earth, where
          // they are hidden by depth test rather than drawn at a bogus spot.
          pos.array[i * 3] = 0; pos.array[i * 3 + 1] = 0; pos.array[i * 3 + 2] = 0;
          lit.array[i] = 0;
          sel.array[i] = 0;
          continue;
        }
        pos.array[i * 3] = sat.sceneX;
        pos.array[i * 3 + 1] = sat.sceneY;
        pos.array[i * 3 + 2] = sat.sceneZ;
        lit.array[i] = sat.sunlit ? 1 : 0;
        sel.array[i] = sat === state.selected ? 1 : (sat === state.hovered ? 0.5 : 0);
      }
      pos.needsUpdate = true;
      lit.needsUpdate = true;
      sel.needsUpdate = true;
      geom.setDrawRange(0, list.length);
    }

    function rebuildTrails() {
      const list = state.rendered;
      const geom = state.trails.geometry;
      const pos = geom.getAttribute('position');
      const col = geom.getAttribute('aColor');
      const fade = geom.getAttribute('aFade');

      if (!state.showTrails || list.length > state.trailBudget) {
        geom.setDrawRange(0, 0);
        return;
      }

      let v = 0;
      for (const sat of list) {
        if (!sat.ok) continue;
        // A trail should read as a fraction of the orbit, so its time span
        // scales with the period — a GEO object barely moves Earth-relative
        // and correctly gets almost no tail.
        const span = Math.max(30, Math.min(150, sat.periodMin * 60 * 0.025));
        const pts = engine.trailPoints(sat, TRAIL_POINTS, span);
        if (!pts) continue;
        const rgb = sat.rgb || (sat.rgb = hexToRgb(sat.color));

        for (let k = 0; k < TRAIL_POINTS - 1; k += 1) {
          if ((v + 2) * 3 > pos.array.length) break;
          for (const idx of [k, k + 1]) {
            pos.array[v * 3] = pts[idx * 3];
            pos.array[v * 3 + 1] = pts[idx * 3 + 1];
            pos.array[v * 3 + 2] = pts[idx * 3 + 2];
            col.array[v * 3] = rgb[0];
            col.array[v * 3 + 1] = rgb[1];
            col.array[v * 3 + 2] = rgb[2];
            // Fades to nothing at the far end of the tail.
            fade.array[v] = (1 - idx / (TRAIL_POINTS - 1)) ** 1.6;
            v += 1;
          }
        }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      fade.needsUpdate = true;
      geom.setDrawRange(0, v);
    }

    // --- per-frame ------------------------------------------------------
    let sunAt = 0;
    function tick() {
      state.frame += 1;
      state.framesSince += 1;
      const now = performance.now();
      if (now - state.lastFpsAt >= 1000) {
        state.fps = Math.round((state.framesSince * 1000) / (now - state.lastFpsAt));
        state.framesSince = 0;
        state.lastFpsAt = now;
      }

      // A resync can reallocate the geometry, and disposing the object three
      // is mid-way through drawing is asking for trouble — so defer it out of
      // the render callback. The page normally calls refreshCatalogue()
      // directly; this is the safety net for anything that does not.
      if (state.catalogueVersion !== engine.version && !state.syncQueued) {
        state.syncQueued = true;
        requestAnimationFrame(() => { state.syncQueued = false; syncCatalogue(); });
      }

      // 5 ms of SGP4 per frame keeps a 60 fps budget intact while still
      // sweeping a few hundred objects a second.
      const swept = engine.step(5);
      writePositions();
      if (swept) rebuildTrails();

      if (now - sunAt > 20000) { updateSun(); sunAt = now; }
      pointUniforms.uPixelRatio.value = renderer.getPixelRatio();
    }

    // --- selection ------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 1.6;
    const pointer = new THREE.Vector2();

    const satVec = new THREE.Vector3();
    const rayVec = new THREE.Vector3();

    /**
     * True when the Earth sits between the camera and the satellite. The
     * raycaster knows nothing about the globe mesh, so without this you can
     * click straight through the planet and select the far side.
     */
    function occluded(sat) {
      const cam = globe.camera().position;
      satVec.set(sat.sceneX, sat.sceneY, sat.sceneZ);
      rayVec.copy(satVec).sub(cam);
      const lenSq = rayVec.lengthSq();
      if (lenSq === 0) return false;
      // Parameter of the point on the camera→satellite segment nearest Earth's
      // centre; only a hit strictly between the endpoints occludes.
      const t = -cam.dot(rayVec) / lenSq;
      if (t <= 0 || t >= 1) return false;
      return rayVec.multiplyScalar(t).add(cam).length() < SCENE_RADIUS * 0.999;
    }

    function pick(event) {
      if (!state.points || !state.rendered.length) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, globe.camera());
      const hits = raycaster.intersectObject(state.points, false);
      for (const hit of hits) {
        const sat = state.rendered[hit.index];
        if (!sat || !sat.ok || occluded(sat)) continue;
        return sat;
      }
      return null;
    }

    let hoverRaf = 0;
    renderer.domElement.addEventListener('pointermove', (event) => {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const sat = pick(event);
        if (sat !== state.hovered) {
          state.hovered = sat;
          renderer.domElement.style.cursor = sat ? 'pointer' : '';
          state.onHover(sat, event);
        }
      });
    });

    let downAt = null;
    renderer.domElement.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('pointerup', (event) => {
      // Ignore the pointerup that ends a drag-to-rotate.
      if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) return;
      const sat = pick(event);
      state.onSelect(sat);
    });

    // --- public surface --------------------------------------------------
    return {
      globe,
      get fps() { return state.fps; },

      attachFX(fxOptions) {
        state.fx = global.CrucixGlobeFX
          ? global.CrucixGlobeFX.attach(globe, fxOptions)
          : null;
        return state.fx;
      },

      resize(width, height) {
        globe.width(width);
        globe.height(height);
      },

      setAutoRotate(on) { globe.controls().autoRotate = on; },

      /** Stop or start Globe.gl's render loop when the view is switched away. */
      setRunning(on) {
        if (on) globe.resumeAnimation();
        else globe.pauseAnimation();
      },

      setTrails(on) {
        state.showTrails = on;
        rebuildTrails();
      },

      setNightLights(on) { earthUniforms.uNightLights.value = on ? 7.5 : 0; },
      setRelief(on) { earthUniforms.uRelief.value = on ? 1 : 0; },
      setGlint(on) { earthUniforms.uGlint.value = on ? 0.55 : 0; },

      refreshCatalogue: syncCatalogue,

      select(sat) {
        state.selected = sat;
        drawSelection();
      },

      get selected() { return state.selected; },

      /** Fly the camera to a lat/lng, cancelling auto-rotate. */
      focus(lat, lng, altitude = 1.4, ms = 900) {
        globe.controls().autoRotate = false;
        globe.pointOfView({ lat, lng, altitude }, ms);
      },

      observer(lat, lng) {
        globe.ringsData([{
          lat, lng, color: '#ffb84c', maxRadius: 2.2, speed: 1.1, period: 1400,
        }]);
      },

      redrawSelection: drawSelection,
      updateSun,
    };

    /** Orbit track, ground track and horizon footprint for the selection. */
    function drawSelection() {
      const sat = state.selected;
      if (!sat) {
        globe.pathsData([]);
        return;
      }
      const paths = [];

      const orbit = engine.orbitPath(sat, 220)
        .map(([lat, lng, altKm]) => [lat, lng, engine.compressAlt(altKm)]);
      for (const run of splitAtAntimeridian(orbit)) {
        paths.push({ coords: run, color: sat.color, stroke: 0.55 });
      }

      const fixed = engine.geodetic(sat);
      if (fixed) {
        const centralDeg = Math.acos(
          engine.R_EARTH / (engine.R_EARTH + Math.max(1, sat.altKm)),
        ) / DEG;
        for (const run of splitAtAntimeridian(circleAround(fixed.lat, fixed.lng, centralDeg))) {
          paths.push({ coords: run, color: 'rgba(255,255,255,0.32)', stroke: 0.3 });
        }
      }

      globe.pathsData(paths);
    }

    /** Points of the circle at `radiusDeg` of arc around a sub-satellite point. */
    function circleAround(lat, lng, radiusDeg, steps = 90) {
      const out = [];
      const latR = lat * DEG;
      const lngR = lng * DEG;
      const r = radiusDeg * DEG;
      for (let i = 0; i <= steps; i += 1) {
        const brg = (i / steps) * Math.PI * 2;
        const sinLat = Math.sin(latR) * Math.cos(r) + Math.cos(latR) * Math.sin(r) * Math.cos(brg);
        const pLat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
        const pLng = lngR + Math.atan2(
          Math.sin(brg) * Math.sin(r) * Math.cos(latR),
          Math.cos(r) - Math.sin(latR) * sinLat,
        );
        out.push([pLat / DEG, (((pLng / DEG) + 540) % 360) - 180, 0.002]);
      }
      return out;
    }

    /** A path crossing ±180° must be cut, or the line shortcuts the globe. */
    function splitAtAntimeridian(coords) {
      const runs = [];
      let run = [];
      for (let i = 0; i < coords.length; i += 1) {
        const prev = coords[i - 1];
        if (prev && Math.abs(coords[i][1] - prev[1]) > 180) {
          if (run.length > 1) runs.push(run);
          run = [];
        }
        run.push(coords[i]);
      }
      if (run.length > 1) runs.push(run);
      return runs;
    }
  }

  global.SatGlobe3D = { create };
})(window);
