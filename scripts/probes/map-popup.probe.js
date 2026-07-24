/**
 * Regression probe for the map popup.
 *
 *   node scripts/browser-probe.mjs --wait-for '.nuke-clickable[data-site]' \
 *        scripts/probes/map-popup.probe.js
 *
 * Guards the bug where the Nuclear Watch site rows resolved #mapPopup and
 * overwrote its innerHTML, deleting the .pp-head/.pp-text/.pp-meta children
 * showPopup() writes into. Every later map marker click then threw
 * "Cannot set properties of null (setting 'textContent')". The nuke card now
 * uses its own #nukePopup on document.body.
 *
 * Clicks the Nuclear Watch row first to arm the old trigger, then every flat
 * map marker. Returns pass:false if any marker throws or renders no popup.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const errors = [];
window.addEventListener('error', e => errors.push(e.message));

const popupIntact = () => {
  const p = document.getElementById('mapPopup');
  return !!(p && p.querySelector('.pp-head') && p.querySelector('.pp-text') && p.querySelector('.pp-meta'));
};

if (!popupIntact()) failures.push('#mapPopup markup incomplete on load');

// Sensor grid rows must never disturb the popup.
for (const el of document.querySelectorAll('.layer-item[data-category]')) {
  const name = el.querySelector('.layer-name')?.textContent.trim();
  try { el.click(); } catch (e) { failures.push(`layer row "${name}" threw: ${e.message}`); }
  await sleep(120);
  if (!popupIntact()) failures.push(`layer row "${name}" damaged #mapPopup`);
}

// Arm the original trigger.
const nukeRow = document.querySelector('.nuke-clickable[data-site]');
if (nukeRow) {
  nukeRow.click();
  await sleep(600);
  if (!popupIntact()) failures.push('Nuclear Watch row clobbered #mapPopup children (the original bug)');
  const np = document.getElementById('nukePopup');
  if (!np) failures.push('#nukePopup was not created');
  else if (np.parentElement !== document.body) failures.push('#nukePopup is not a direct child of <body>');
}

// Every flat map marker must still open a popup.
const markers = [...document.querySelectorAll('#flatMapSvg g.markers > g')];
const byLayer = {};
for (const g of markers) {
  try {
    g.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 480, clientY: 280 }));
    const p = document.getElementById('mapPopup');
    const layer = p.querySelector('.pp-meta')?.textContent || '(none)';
    byLayer[layer] = (byLayer[layer] || 0) + 1;
    if (!p.classList.contains('show')) failures.push(`marker for "${layer}" opened no popup`);
  } catch (e) {
    failures.push(`marker threw: ${e.message}`);
  }
}
if (!markers.length) failures.push('no flat map markers found — is the map in globe mode?');

return {
  pass: failures.length === 0 && errors.length === 0,
  markersClicked: markers.length,
  popupsByLayer: byLayer,
  uncaughtErrors: errors,
  failures,
};
