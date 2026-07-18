import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'dashboard/public/jarvis.html'), 'utf8');

describe('dashboard right-rail interactions', () => {
  it('renders delta, cross-source, core, and OSINT rows as accessible controls', () => {
    for (const item of ['delta', 'signal', 'core', 'osint']) {
      assert.match(html, new RegExp(`data-right-item="${item}"`));
    }
    assert.match(html, /class="[^"]*right-interactive[^"]*" tabindex="0" role="button" aria-expanded="false"/);
    assert.match(html, /class="right-item-detail"/);
  });

  it('uses refresh-safe delegated click and keyboard handling', () => {
    assert.match(html, /Right-rail interactions: refresh-safe accordions/);
    assert.match(html, /document\.addEventListener\('click',event=>/);
    assert.match(html, /document\.addEventListener\('keydown',event=>/);
    assert.match(html, /event\.key!=='Enter'&&event\.key!==' '/);
    assert.match(html, /function toggleRightItem/);
    assert.match(html, /collapseRightItems\(document\)/);
  });

  it('focuses geolocated items in either flat-map or globe mode', () => {
    assert.match(html, /function focusDashboardMap/);
    assert.match(html, /setPrimaryView\('map'\)/);
    assert.match(html, /flatSvg\.transition\(\)\.duration\(850\)/);
    assert.match(html, /globe\.pointOfView\(\{lat:t2\.lat,lng:t2\.lng,altitude:t2\.altitude\},850\)/);
    assert.match(html, /rightMapActionMarkup/);
    assert.match(html, /data-map-lat/);
  });

  it('adds full report context and source actions to OSINT items', () => {
    assert.match(html, /OSINT report/);
    assert.match(html, /right-detail-copy/);
    assert.match(html, /Locate report/);
    assert.match(html, /Open source &#8599;/);
  });
});
