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
    assert.match(html, /data-ticker-id/);
    assert.match(html, /e\.key === 'Enter' \|\| e\.key === ' '/);
    assert.match(html, /e\.key === 'Escape' && expandedTickerId/);
    assert.match(html, /expandedTickerId = expandedTickerId === card\.dataset\.tickerId \? null : card\.dataset\.tickerId/);
  });
});
