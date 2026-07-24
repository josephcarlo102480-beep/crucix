(function (global) {
  'use strict';

  const GLOBE_RADIUS = 100; // three-globe's fixed GLOBE_RADIUS, in scene units.
  const QUALITY_MAX = 3;
  const QUALITY_MIN = 0;
  const LOW_FPS = 26;
  const HIGH_FPS = 45;
  const LOW_HOLD_MS = 2000;
  const HIGH_HOLD_MS = 4000;
  const FPS_WINDOW_MS = 1000;

  const SHELL_VERTEX_SHADER = [
    'varying vec3 vWorldNormal;',
    'varying vec3 vWorldPosition;',
    'void main() {',
    '  vec4 worldPosition = modelMatrix * vec4(position, 1.0);',
    '  vWorldPosition = worldPosition.xyz;',
    '  vWorldNormal = normalize(mat3(modelMatrix) * normal);',
    '  gl_Position = projectionMatrix * viewMatrix * worldPosition;',
    '}',
  ].join('\n');

  const SHELL_FRAGMENT_SHADER = [
    'uniform vec3 uColor;',
    'uniform vec3 uSunDirection;',
    'uniform float uEarthRadius;',
    'uniform float uScaleHeight;',
    'uniform float uIntensity;',
    'uniform float uSunStrength;',
    'varying vec3 vWorldNormal;',
    'varying vec3 vWorldPosition;',
    'void main() {',
    '  vec3 rayDir = normalize(vWorldPosition - cameraPosition);',
    '  float b = length(cross(rayDir, -cameraPosition));',
    '  float h = max(0.0, b - uEarthRadius);',
    '  float falloff = exp(-h / uScaleHeight);',
    '  vec3 closest = cameraPosition + rayDir * dot(-cameraPosition, rayDir);',
    '  float dayFacing = smoothstep(-0.35, 0.35, dot(normalize(closest), uSunDirection));',
    '  float sunlight = mix(1.0, mix(0.18, 1.0, dayFacing), uSunStrength);',
    '  gl_FragColor = vec4(uColor * uIntensity * sunlight, falloff);',
    '}',
  ].join('\n');

  const STAR_VERTEX_SHADER = [
    'uniform float uPixelRatio;',
    'attribute float aSize;',
    'attribute float aBrightness;',
    'attribute vec3 aColor;',
    'varying float vBrightness;',
    'varying vec3 vColor;',
    'void main() {',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  vBrightness = aBrightness;',
    '  vColor = aColor;',
    '  gl_PointSize = aSize * uPixelRatio;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '}',
  ].join('\n');

  const STAR_FRAGMENT_SHADER = [
    'varying float vBrightness;',
    'varying vec3 vColor;',
    'void main() {',
    '  float distanceToCenter = length(gl_PointCoord - vec2(0.5));',
    '  float halo = 1.0 - smoothstep(0.16, 0.5, distanceToCenter);',
    '  float core = 1.0 - smoothstep(0.0, 0.12, distanceToCenter);',
    '  float alpha = (halo * 0.55 + core * 0.45) * vBrightness;',
    '  if (alpha <= 0.0) discard;',
    '  gl_FragColor = vec4(vColor, alpha);',
    '}',
  ].join('\n');

  function noopHandle() {
    return {
      setQuality: function () {},
      lock: function () {},
      dispose: function () {},
      stats: function () {
        return {
          active: false,
          quality: null,
          fps: null,
          dpr: null,
          starCount: 0,
          adaptiveLocked: true,
        };
      },
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finiteNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function mulberry32(seed) {
    let state = seed >>> 0;
    return function () {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function assertFiniteGeometry(geometry, label) {
    const attributes = geometry.attributes || {};
    Object.keys(attributes).forEach(function (name) {
      const array = attributes[name].array;
      for (let i = 0; i < array.length; i += 1) {
        if (!Number.isFinite(array[i])) {
          throw new Error(label + ' has a non-finite ' + name + ' value at index ' + i);
        }
      }
    });

    if (geometry.index && geometry.index.array) {
      const index = geometry.index.array;
      for (let i = 0; i < index.length; i += 1) {
        if (!Number.isFinite(index[i])) {
          throw new Error(label + ' has a non-finite index value at index ' + i);
        }
      }
    }
  }

  function normalizeDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function normalizeLongitude(value) {
    return ((value + 540) % 360) - 180;
  }

  function subsolar(ms) {
    const radians = Math.PI / 180;
    const julianDay = ms / 86400000 + 2440587.5;
    const daysSinceJ2000 = julianDay - 2451545.0;
    const meanAnomaly = normalizeDegrees(357.529 + 0.98560028 * daysSinceJ2000) * radians;
    const meanLongitude = normalizeDegrees(280.459 + 0.98564736 * daysSinceJ2000);
    const eclipticLongitude = normalizeDegrees(
      meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)
    ) * radians;
    const obliquity = (23.439 - 0.00000036 * daysSinceJ2000) * radians;
    const rightAscension = normalizeDegrees(
      Math.atan2(
        Math.cos(obliquity) * Math.sin(eclipticLongitude),
        Math.cos(eclipticLongitude)
      ) / radians
    );
    const declination = Math.asin(
      Math.sin(obliquity) * Math.sin(eclipticLongitude)
    ) / radians;
    const greenwichSiderealTime = normalizeDegrees(
      280.46061837 + 360.98564736629 * daysSinceJ2000
    );

    return {
      lat: declination,
      lng: normalizeLongitude(rightAscension - greenwichSiderealTime),
    };
  }

  function latLngToDirection(lat, lng) {
    const latRadians = lat * Math.PI / 180;
    const lngRadians = lng * Math.PI / 180;
    const cosLat = Math.cos(latRadians);
    return new THREE.Vector3(
      cosLat * Math.sin(lngRadians),
      Math.sin(latRadians),
      cosLat * Math.cos(lngRadians)
    ).normalize();
  }

  function createShell(radius, scaleHeight, intensity, color, sunDirection, sunStrength, type) {
    const geometry = new THREE.SphereGeometry(radius, 64, 32);
    assertFiniteGeometry(geometry, type);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color },
        uSunDirection: { value: sunDirection },
        uEarthRadius: { value: GLOBE_RADIUS },
        uScaleHeight: { value: scaleHeight },
        uIntensity: { value: intensity },
        uSunStrength: { value: sunStrength },
      },
      vertexShader: SHELL_VERTEX_SHADER,
      fragmentShader: SHELL_FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'CrucixGlobeFX-' + type;
    mesh.userData.crucixFX = true;
    mesh.userData.crucixFXType = type;
    return mesh;
  }

  function createStarfield(count, seed, pixelRatio) {
    const random = mulberry32(seed);
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const brightness = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const radius = 800 + random() * 200;
      const z = random() * 2 - 1;
      const azimuth = random() * Math.PI * 2;
      const radial = Math.sqrt(Math.max(0, 1 - z * z));
      const offset = i * 3;
      positions[offset] = radius * radial * Math.cos(azimuth);
      positions[offset + 1] = radius * z;
      positions[offset + 2] = radius * radial * Math.sin(azimuth);

      const prominent = random() > 0.955;
      sizes[i] = prominent ? 2.4 + random() * 0.9 : 0.8 + random() * 1.1;
      brightness[i] = prominent ? 1.0 : 0.55 + random() * 0.45;

      const warmth = random();
      colors[offset] = 0.76 + warmth * 0.24;
      colors[offset + 1] = 0.84 + warmth * 0.16;
      colors[offset + 2] = 1.0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setDrawRange(0, count);
    assertFiniteGeometry(geometry, 'starfield');

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: pixelRatio },
      },
      vertexShader: STAR_VERTEX_SHADER,
      fragmentShader: STAR_FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'CrucixGlobeFX-stars';
    points.frustumCulled = false;
    points.userData.crucixFX = true;
    points.userData.crucixFXType = 'stars';
    return points;
  }

  function buildAttachment(globe, options) {
    const settings = options || {};
    const scene = globe.scene();
    const renderer = globe.renderer();
    const devicePixelRatio = finiteNumber(global.devicePixelRatio, 1);
    const dprCap = Math.max(0.5, finiteNumber(settings.dprCap, 1.75));
    const originalPixelRatio = renderer.getPixelRatio();
    const fullPixelRatio = Math.min(devicePixelRatio, dprCap);

    // Apply the DPR cap before allocating any optional FX geometry.
    renderer.setPixelRatio(fullPixelRatio);

    const shellsEnabled = settings.shells !== false;
    const starsEnabled = settings.stars !== false;
    const sunEnabled = settings.sun !== false;
    const adaptiveEnabled = settings.adaptive !== false;
    const starCount = Math.max(1, Math.floor(finiteNumber(settings.starCount, 5000)));
    const starSeed = Math.floor(finiteNumber(settings.starSeed, 1337)) >>> 0;
    const sunStrength = sunEnabled
      ? clamp(finiteNumber(settings.sunStrength, 1), 0, 1)
      : 0;
    const color = new THREE.Color(settings.color || '#64f0c8');
    const sunDirection = latLngToDirection(0, 0);
    const objects = [];
    const shells = [];
    let starfield = null;

    if (shellsEnabled) {
      shells.push(createShell(
        GLOBE_RADIUS * 1.165, 6.0, 0.35, color, sunDirection, sunStrength, 'shell-outer'
      ));
      shells.push(createShell(
        GLOBE_RADIUS * 1.048, 1.05, 0.77, color, sunDirection, sunStrength, 'shell-middle'
      ));
      shells.push(createShell(
        GLOBE_RADIUS * 1.004, 0.09, 0.55, color, sunDirection, sunStrength, 'shell-inner'
      ));
      objects.push.apply(objects, shells);
    }

    if (starsEnabled) {
      starfield = createStarfield(starCount, starSeed, fullPixelRatio);
      objects.push(starfield);
    }

    objects.forEach(function (object) {
      scene.add(object);
    });

    let disposed = false;
    let quality = QUALITY_MAX;
    let adaptiveLocked = !adaptiveEnabled;
    let measuredFps = null;
    let lowSince = 0;
    let highSince = 0;
    let frameTimes = [];
    let sunTimer = null;
    let observer = null;
    let fxPaused = false;
    let documentHidden = typeof document !== 'undefined' && document.hidden;
    const canvas = renderer.domElement;
    const container = canvas && canvas.parentElement;
    let offscreen = Boolean(
      container && typeof container.getClientRects === 'function' &&
      container.getClientRects().length === 0
    );

    function currentStarCount() {
      if (!starfield) return 0;
      return quality === QUALITY_MIN ? Math.ceil(starCount / 2) : starCount;
    }

    function applyQuality(nextQuality) {
      if (disposed) return;
      quality = clamp(Math.round(finiteNumber(nextQuality, quality)), QUALITY_MIN, QUALITY_MAX);
      const pixelRatio = quality <= 1 ? Math.min(devicePixelRatio, 1) : fullPixelRatio;
      renderer.setPixelRatio(pixelRatio);

      if (shells.length > 0) {
        shells[0].visible = quality === QUALITY_MAX;
      }
      if (starfield) {
        starfield.geometry.setDrawRange(0, currentStarCount());
        starfield.material.uniforms.uPixelRatio.value = pixelRatio;
      }
    }

    function updateSunDirection() {
      if (disposed || !sunEnabled || shells.length === 0) return;
      const position = subsolar(Date.now());
      sunDirection.copy(latLngToDirection(position.lat, position.lng));
    }

    function resetFpsWindow() {
      frameTimes = [];
      lowSince = 0;
      highSince = 0;
    }

    function sampleFrame() {
      if (disposed) return;
      const now = global.performance && typeof global.performance.now === 'function'
        ? global.performance.now()
        : Date.now();
      frameTimes.push(now);
      while (frameTimes.length > 0 && frameTimes[0] < now - FPS_WINDOW_MS) {
        frameTimes.shift();
      }

      if (frameTimes.length < 2) return;
      const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
      if (span < FPS_WINDOW_MS * 0.75) return;
      measuredFps = (frameTimes.length - 1) * 1000 / span;

      if (adaptiveLocked) return;
      if (measuredFps < LOW_FPS && quality > QUALITY_MIN) {
        highSince = 0;
        if (!lowSince) lowSince = now;
        if (now - lowSince >= LOW_HOLD_MS) {
          applyQuality(quality - 1);
          resetFpsWindow();
        }
      } else if (measuredFps > HIGH_FPS && quality < QUALITY_MAX) {
        lowSince = 0;
        if (!highSince) highSince = now;
        if (now - highSince >= HIGH_HOLD_MS) {
          applyQuality(quality + 1);
          resetFpsWindow();
        }
      } else {
        lowSince = 0;
        highSince = 0;
      }
    }

    const sampler = starfield || shells[shells.length - 1];
    if (sampler) sampler.onBeforeRender = sampleFrame;

    function syncAnimation() {
      if (disposed) return;
      const shouldPause = documentHidden || offscreen;
      if (shouldPause && !fxPaused && typeof globe.pauseAnimation === 'function') {
        globe.pauseAnimation();
        fxPaused = true;
      } else if (!shouldPause && fxPaused && typeof globe.resumeAnimation === 'function') {
        globe.resumeAnimation();
        fxPaused = false;
        resetFpsWindow();
      }
    }

    function onVisibilityChange() {
      documentHidden = document.hidden;
      syncAnimation();
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    if (container && typeof global.IntersectionObserver === 'function') {
      observer = new global.IntersectionObserver(function (entries) {
        if (disposed || entries.length === 0) return;
        offscreen = !entries[0].isIntersecting;
        syncAnimation();
      });
      observer.observe(container);
    }

    updateSunDirection();
    if (sunEnabled && shells.length > 0) {
      sunTimer = global.setInterval(updateSunDirection, 60000);
    }
    applyQuality(QUALITY_MAX);
    syncAnimation();

    return {
      setQuality: function (nextQuality) {
        applyQuality(nextQuality);
      },
      lock: function () {
        adaptiveLocked = true;
        lowSince = 0;
        highSince = 0;
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (sunTimer !== null) global.clearInterval(sunTimer);
        if (observer) observer.disconnect();
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        objects.forEach(function (object) {
          scene.remove(object);
          object.geometry.dispose();
          object.material.dispose();
        });
        renderer.setPixelRatio(originalPixelRatio);
      },
      stats: function () {
        return {
          active: !disposed,
          quality: quality,
          fps: measuredFps === null ? null : Math.round(measuredFps * 10) / 10,
          dpr: disposed ? originalPixelRatio : renderer.getPixelRatio(),
          starCount: disposed ? 0 : currentStarCount(),
          adaptiveLocked: adaptiveLocked,
        };
      },
    };
  }

  function attach(globe, options) {
    if (!globe) {
      console.warn('[CrucixGlobeFX] attach skipped: globe instance is unavailable.');
      return noopHandle();
    }
    if (typeof THREE === 'undefined') {
      console.warn('[CrucixGlobeFX] attach skipped: THREE is unavailable.');
      return noopHandle();
    }

    try {
      return buildAttachment(globe, options);
    } catch (error) {
      console.warn('[CrucixGlobeFX] attach failed:', error);
      return noopHandle();
    }
  }

  global.CrucixGlobeFX = Object.freeze({
    attach: attach,
  });
})(window);
