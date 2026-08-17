// Run through scripts/browser-probe.mjs against /satellites.html. This file is
// the body of an async browser function, so top-level await/return are expected.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = {};
const mark = (name, pass, detail = '') => {
  checks[name] = { pass: Boolean(pass), detail };
};

const tracker = window.crucixSat;
const engine = tracker?.engine;
if (!tracker || !engine || !tracker.globe3d) {
  return { pass: false, checks, error: 'satellite tracker did not boot' };
}

const groupButtonFor = (sat) => document.querySelector(`.cat-btn[data-group="${sat.group}"]`);
const target = engine.visibleSats().find((sat) => sat.ok && groupButtonFor(sat));
if (!target) return { pass: false, checks, error: 'no rendered satellite with a catalogue group' };

// Keep the camera still while projecting a real point into canvas coordinates.
document.querySelector('#optRotate').checked = false;
tracker.globe3d.setAutoRotate(false);

const globe = tracker.globe3d.globe;
const canvas = globe.renderer().domElement;
const camera = globe.camera();

function isOccluded(sat) {
  const cam = camera.position;
  const point = new THREE.Vector3(sat.sceneX, sat.sceneY, sat.sceneZ);
  const ray = point.clone().sub(cam);
  const lenSq = ray.lengthSq();
  if (!lenSq) return false;
  const t = -cam.dot(ray) / lenSq;
  return t > 0 && t < 1 && ray.multiplyScalar(t).add(cam).length() < 99.9;
}

function project(sat) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector3(sat.sceneX, sat.sceneY, sat.sceneZ).project(camera);
  return {
    x: rect.left + ((ndc.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndc.y) / 2) * rect.height,
    inFrame: Math.abs(ndc.x) < 0.96 && Math.abs(ndc.y) < 0.96 && ndc.z < 1,
  };
}

function clickCanvasPoint(point) {
  const init = { bubbles: true, clientX: point.x, clientY: point.y, pointerId: 1, pointerType: 'mouse' };
  // Synthetic PointerEvents are not registered with Firefox's native pointer
  // table, so OrbitControls' capture call would otherwise throw even though
  // the app's raycaster handles the event correctly.
  const capture = canvas.setPointerCapture;
  const release = canvas.releasePointerCapture;
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  try {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, button: 0, buttons: 0 }));
  } finally {
    canvas.setPointerCapture = capture;
    canvas.releasePointerCapture = release;
  }
}

// Pick a front-side point through the same raycaster used by real pointer input.
const clickable = engine.visibleSats().find((sat) => sat.ok && !isOccluded(sat) && project(sat).inFrame);
if (!clickable) return { pass: false, checks, error: 'no front-side satellite was clickable' };
clickCanvasPoint(project(clickable));
await sleep(1100);
mark('real dot selects', tracker.selected === clickable, tracker.selected?.name || 'nothing selected');
mark('selection does not auto-follow', document.querySelector('#btnFollow').getAttribute('aria-pressed') === 'false');

// Click well away from every rendered point to exit the selection.
const canvasRect = canvas.getBoundingClientRect();
const projected = engine.visibleSats().filter((sat) => sat.ok && !isOccluded(sat)).map(project);
let blank3d = { x: canvasRect.left + 30, y: canvasRect.top + 30 };
let blankDistance = -1;
for (let y = canvasRect.top + 30; y < canvasRect.bottom - 30; y += 80) {
  for (let x = canvasRect.left + 30; x < canvasRect.right - 30; x += 80) {
    const nearest = projected.reduce((best, point) => Math.min(best, Math.hypot(point.x - x, point.y - y)), Infinity);
    if (nearest > blankDistance) { blankDistance = nearest; blank3d = { x, y }; }
  }
}
clickCanvasPoint(blank3d);
await sleep(80);
mark('blank 3D globe deselects', tracker.selected === null, `nearest satellite ${blankDistance.toFixed(1)}px`);

tracker.select(target, false);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(20);
mark('Escape deselects', tracker.selected === null);

tracker.select(target, false);
document.querySelector('#btnFollow').click();
const followEnabled = document.querySelector('#btnFollow').getAttribute('aria-pressed') === 'true';
document.querySelector('#btnCloseSel').click();
await sleep(20);
mark('close stops explicit follow', followEnabled && tracker.selected === null
  && document.querySelector('#btnFollow').getAttribute('aria-pressed') === 'false');

tracker.setView('2d');
await sleep(100);
tracker.select(target, false);
const map = tracker.map;
document.querySelector('#btnFollow').click();
await sleep(4200);
const followed = engine.geodetic(target);
const center = map.getCenter();
mark('Follow pans the 2D map', followed
  && center.distanceTo(L.latLng(followed.lat, followed.lng)) < 150000);
const size = map.getSize();
let blank = L.point(30, 30);
let widest = -1;
for (let y = 30; y < size.y - 30; y += 70) {
  for (let x = 30; x < size.x - 30; x += 70) {
    const point = L.point(x, y);
    let nearest = Infinity;
    for (const sat of engine.visibleSats()) {
      const fixed = engine.geodetic(sat);
      if (!fixed) continue;
      nearest = Math.min(nearest, point.distanceTo(map.latLngToContainerPoint([fixed.lat, fixed.lng])));
    }
    if (nearest > widest) { widest = nearest; blank = point; }
  }
}
map.fire('click', { containerPoint: blank, originalEvent: new MouseEvent('click') });
await sleep(20);
mark('blank 2D map deselects', tracker.selected === null, `nearest satellite ${widest.toFixed(1)}px`);

// A selected object cannot survive after its whole group is hidden.
tracker.setView('3d');
const groupButton = groupButtonFor(target);
tracker.select(target, false);
groupButton.click();
await sleep(50);
mark('hiding selected group deselects', tracker.selected === null
  && document.querySelector('#btnFollow').getAttribute('aria-pressed') === 'false');
tracker.select(target, false); // simulate a stale pass/overhead row
mark('hidden target cannot be reselected', tracker.selected === null);
groupButton.click(); // restore the page for screenshots or follow-up probes

const pass = Object.values(checks).every((check) => check.pass);
return { pass, target: target.name, clicked: clickable.name, checks };
