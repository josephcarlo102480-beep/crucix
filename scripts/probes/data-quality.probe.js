// Run against scripts/browser-probe.mjs and a local Crucix instance/preview.
// Only the temporary page state changes; no server writes or AI requests.
const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
const saved = D;
const wasCollapsed = heroCollapsed;
const initialLayout = {
  width: innerWidth, height: innerHeight,
  scrollWidth: document.documentElement.scrollWidth,
  mapTop: document.getElementById('mapStage').getBoundingClientRect().top,
  briefCollapsed: document.getElementById('heroStrip').classList.contains('collapsed'),
};
try {
  check(initialLayout.scrollWidth <= innerWidth, 'page must not overflow horizontally');
  check(initialLayout.briefCollapsed, 'new browser session starts with compact brief');
  if (innerWidth > 1100) check(initialLayout.mapTop < 250, 'desktop map should begin within first 250px');
  const opener = document.querySelector('.hero-collapsed-row [data-source-health]');
  opener.focus(); opener.click();
  const dialog = document.getElementById('sourceHealthDialog');
  check(dialog.open, 'coverage button opens dialog');
  check(dialog.querySelectorAll('.source-health-row').length === D.health.length, 'every source is listed');
  check(dialog.innerText.includes('Last observation:') && dialog.innerText.includes('Last successful collection:'), 'coverage exposes observation and collection times separately');
  check(dialog.innerText.includes('Next step:'), 'affected feeds have recovery steps');
  dialog.querySelector('button').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  check(!dialog.open && document.activeElement === opener, 'closing coverage returns keyboard focus');

  D = normalizeDashboardData({ ...saved, nuke: [], health: [{ n: 'Example', status: 'failed', err: true, reason: '<img src=x onerror=alert(1)>', recovery: 'Retry later' }] });
  renderLeftRail(); renderSourceHealth();
  check(document.querySelector('.nuke-ok').textContent.includes('UNKNOWN'), 'empty nuclear coverage is unknown');
  check(!dialog.querySelector('img'), 'upstream errors are rendered as text');
  D.nuke = [
    { site: 'Old station', status: 'stale', lastReading: '2016-11-30T00:00:00Z', anom: null, cpm: null, n: 0 },
    { site: 'Missing station', status: 'unknown', lastReading: null, anom: null, cpm: null, n: 0 },
  ];
  renderLeftRail();
  check(!document.getElementById('leftRail').innerText.includes('NORMAL'), 'stale and missing sites must never be normal');
  check(document.getElementById('leftRail').innerText.includes('2016'), 'old observation dates remain visible');
  check(fmtNum(null) === '--' && fmtInt(null) === '--' && fmtSigned(null) === '--', 'unknown numbers stay unknown in UI');
  check(getAge(new Date(Date.now() - 8 * 60000).toISOString()) === '8m ago', 'sweep age resolves minutes');
  toggleHeroCollapsed();
  check(!document.getElementById('heroStrip').classList.contains('collapsed'), 'brief expands');
  check(document.querySelector('.hero-card [data-source-health]') || document.querySelector('.hero-card[data-source-health]'), 'expanded brief exposes source details');
} finally {
  D = saved;
  heroCollapsed = wasCollapsed;
  safeStorage.set('crucix_hero_collapsed', String(wasCollapsed));
  reinit();
  window.scrollTo(0, 0);
}
return { pass: failures.length === 0, failures, layout: initialLayout };
