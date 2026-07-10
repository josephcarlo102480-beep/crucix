import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeForInlineScript } from '../dashboard/inject.mjs';
import { MemoryManager } from '../lib/delta/memory.mjs';
import {
  clearTelegramChannelMessages,
  getTelegramChannelMessages,
  recordTelegramUpdate,
} from '../lib/telegramUpdates.mjs';
import { isAskRequestAuthorized } from '../server.mjs';

const dashboardHtml = readFileSync(join(process.cwd(), 'dashboard/public/jarvis.html'), 'utf8');

function snapshot(timestamp, wti) {
  return {
    meta: { timestamp, sourcesOk: 29 },
    fred: [],
    energy: { wti },
    bls: [],
    treasury: {},
    tg: { urgent: [] },
    thermal: [],
    air: [],
    nuke: [],
    who: [],
    acled: {},
    sdr: {},
    news: [],
    health: [],
  };
}

describe('dashboard injection safety', () => {
  it('serializes inline data without a script-closing sequence', () => {
    const value = { title: '</script><script>globalThis.pwned=true</script>' };
    const serialized = serializeForInlineScript(value);
    assert.doesNotMatch(serialized, /<\/script/i);
    assert.deepEqual(JSON.parse(serialized), value);
  });

  it('renders popup rich text as text and always probes live data over HTTP', () => {
    assert.match(dashboardHtml, /setTextWithBreaks\(popup\.querySelector\('\.pp-text'\)/);
    assert.doesNotMatch(dashboardHtml, /popup\.querySelector\('\.pp-text'\)\.innerHTML/);
    assert.match(dashboardHtml, /if \(canProbeApi\) \{/);
    assert.doesNotMatch(dashboardHtml, /canProbeApi && !hasInlineData/);
    assert.match(dashboardHtml, /escapeHtml\(idea\.title\)/);
  });
});

describe('Ask AI exposure policy', () => {
  it('allows loopback without a token and requires the configured token elsewhere', () => {
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null), true);
    assert.equal(isAskRequestAuthorized('0.0.0.0', 'secret', ''), false);
    assert.equal(isAskRequestAuthorized('0.0.0.0', 'secret', 'wrong'), false);
    assert.equal(isAskRequestAuthorized('0.0.0.0', 'secret', 'secret'), true);
  });
});

describe('Telegram shared update snapshot', () => {
  it('captures and replaces channel posts without storing command messages', () => {
    clearTelegramChannelMessages();
    assert.equal(recordTelegramUpdate({ message: { message_id: 1 } }), false);
    assert.equal(recordTelegramUpdate({
      channel_post: {
        message_id: 7,
        date: 1_700_000_000,
        text: 'first',
        chat: { id: -1001, username: 'intel' },
      },
    }), true);
    recordTelegramUpdate({
      edited_channel_post: {
        message_id: 7,
        date: 1_700_000_000,
        edit_date: 1_700_000_100,
        text: 'edited',
        chat: { id: -1001, username: 'intel' },
      },
    });

    const messages = getTelegramChannelMessages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'edited');
    assert.equal(messages[0].channel, 'intel');
    clearTelegramChannelMessages();
  });
});

describe('delta baseline controls', () => {
  it('uses configured thresholds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crucix-thresholds-'));
    try {
      const memory = new MemoryManager(dir, { thresholds: { numeric: { wti: 50 } } });
      memory.addRun(snapshot('2026-07-09T00:00:00.000Z', 100));
      const delta = memory.addRun(snapshot('2026-07-09T00:15:00.000Z', 110));
      assert.equal(delta.signals.escalated.some(signal => signal.key === 'wti'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets instead of alerting against a stale baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crucix-baseline-'));
    try {
      const memory = new MemoryManager(dir, { maxBaselineAgeMs: 30 * 60 * 1000 });
      memory.addRun(snapshot('2026-07-01T00:00:00.000Z', 100));
      const delta = memory.addRun(snapshot('2026-07-09T00:00:00.000Z', 140));
      assert.equal(delta.baselineReset, true);
      assert.equal(delta.summary.totalChanges, 0);
      assert.equal(delta.summary.criticalChanges, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
