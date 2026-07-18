import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'dashboard/public/jarvis.html'), 'utf8');

describe('dashboard ticker expansion', () => {
  it('renders ticker cards as expandable controls with detail content', () => {
    assert.match(html, /function buildTickerCard/);
    assert.match(html, /role="button"/);
    assert.match(html, /aria-expanded="\$\{isOpen\?'true':'false'\}"/);
    assert.match(html, /class="tk-detail"/);
    assert.match(html, /class="tk-raw"/);
  });

  it('supports click, keyboard expand, and escape collapse behavior', () => {
    assert.match(html, /let expandedTickerKey = null/);
    assert.match(html, /data-ticker-key/);
    assert.match(html, /function toggleTickerDetails/);
    assert.match(html, /e\.key === 'Enter' \|\| e\.key === ' '/);
    assert.match(html, /e\.key === 'Escape' && expandedTickerKey/);
    assert.match(html, /expandedTickerKey = expandedTickerKey === key \? null : key/);
  });

  it('pauses, widens, and restores the selected ticker item', () => {
    assert.match(html, /\.lower \.lp-ticker\.ticker-expanded/);
    assert.match(html, /\.ticker-wrap\.has-expanded \.ticker-track\{animation:none/);
    assert.match(html, /function restoreTickerCard/);
    assert.match(html, /scrollIntoView\(\{block:'nearest', inline:'nearest'\}\)/);
  });

  it('shows publisher, audience, and signal context in expanded details', () => {
    assert.match(html, /tk-detail-label">Publisher/);
    assert.match(html, /tk-detail-label">Views/);
    assert.match(html, /tk-detail-label">Signals/);
    assert.match(html, /tk-detail-label">Signal score/);
  });

  it('supports live and pinned ticker modes', () => {
    assert.match(html, /let tickerMode = localStorage\.getItem\('crucix_ticker_mode'\)/);
    assert.match(html, /function setTickerMode/);
    assert.match(html, /class="ticker-tabs"/);
    assert.match(html, /onclick="setTickerMode\('live'\)">Live/);
    assert.match(html, /onclick="setTickerMode\('pinned'\)">Pinned/);
  });

  it('persists ticker item pins separately from panel pinning', () => {
    assert.match(html, /crucix_pinned_ticker_items/);
    assert.match(html, /function toggleTickerPin/);
    assert.match(html, /data-ticker-key/);
    assert.match(html, /toggleTickerPin\('\$\{escapeAttr\(key\)\}'\)/);
    assert.match(html, /Pin panel/);
  });
});
