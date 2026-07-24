/**
 * Regression probe for flat-map layer stacking.
 *
 *   node scripts/browser-probe.mjs --wait-for '#flatMapSvg g.markers' \
 *        scripts/probes/flat-map-layers.probe.js
 *
 * drawFlatMap() appends its graticule/border/markers/corridors instead of
 * replacing them, and init() kicks off two overlapping draws in one tick
 * (initMap() then syncResponsiveLayout(true) -> refreshMapViewport()). Both
 * fetch callbacks used to land, doubling every marker group — 152 markers
 * became 304, each duplicate carrying its own d3 click handler.
 *
 * Fails if any layer is duplicated on load, if repeated redraws grow the
 * counts, or if two overlapping draws both render.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];

const count = () => ({
  markerGroups: document.querySelectorAll('#flatMapSvg g.markers').length,
  markers: document.querySelectorAll('#flatMapSvg g.markers > g').length,
  graticule: document.querySelectorAll('#flatMapSvg path.graticule').length,
  border: document.querySelectorAll('#flatMapSvg path.border').length,
  land: document.querySelectorAll('#flatMapSvg path.land').length,
  corridors: document.querySelectorAll('#flatMapSvg g.corridors-layer').length,
});

const checkSingletons = (label, c) => {
  for (const k of ['markerGroups', 'graticule', 'border', 'corridors']) {
    if (c[k] > 1) failures.push(`${label}: ${k} duplicated (${c[k]}, expected 1)`);
  }
};

if (typeof isFlat !== 'undefined' && !isFlat) { toggleMapMode(); await sleep(2500); }

const onLoad = count();
checkSingletons('onLoad', onLoad);
if (!onLoad.markers) failures.push('onLoad: no markers rendered');

// Serial redraws must be idempotent, not cumulative.
const redraws = [];
for (let i = 0; i < 3; i++) {
  refreshMapViewport();
  await sleep(2500);
  const c = count();
  checkSingletons(`redraw ${i + 1}`, c);
  redraws.push(c);
}
if (new Set(redraws.map(c => c.markers)).size !== 1) {
  failures.push(`marker count unstable across redraws: ${redraws.map(c => c.markers).join(', ')}`);
}

// The boot race: two overlapping draws in one tick, only one may render.
flatG.selectAll('*').remove();
drawFlatMap();
drawFlatMap();
await sleep(3500);
const overlapped = count();
checkSingletons('overlapping draws', overlapped);
if (!overlapped.markers) failures.push('overlapping draws: nothing rendered');

return {
  pass: failures.length === 0,
  onLoad,
  redraws,
  overlapped,
  failures,
};
