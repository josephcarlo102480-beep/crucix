import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBriefSnapshot,
  buildStatusSnapshot,
  formatDiscordBrief,
  formatDiscordStatus,
  formatTelegramBrief,
  formatTelegramStatus,
} from '../lib/bot/messages.mjs';
import { contentHash, getNewSignals, ruleBasedEvaluation } from '../lib/alerts/shared.mjs';
import { DiscordAlerter } from '../lib/alerts/discord.mjs';

describe('bot message builders', () => {
  it('formats shared status content for telegram and discord', () => {
    const snapshot = buildStatusSnapshot({
      startTime: Date.now() - (2 * 3600 + 15 * 60) * 1000,
      currentData: { meta: { sourcesOk: 24, sourcesQueried: 27, sourcesFailed: 3 } },
      llmProvider: { isConfigured: true, name: 'openai' },
      lastSweepTime: '2026-04-19T17:00:00.000Z',
      refreshIntervalMinutes: 15,
      sweepInProgress: false,
      sseClientCount: 4,
      port: 3117,
    });

    const telegram = formatTelegramStatus(snapshot);
    const discord = formatDiscordStatus(snapshot);

    assert.match(telegram, /CRUCIX STATUS/);
    assert.match(telegram, /Sources: 24\/27 OK \(3 failed\)/);
    assert.match(discord, /Dashboard: http:\/\/localhost:3117/);
    assert.match(discord, /LLM: enabled \(openai\)/);
  });

  it('formats shared brief content for telegram and discord', () => {
    const snapshot = buildBriefSnapshot({
      currentData: {
        fred: [{ id: 'VIXCLS', value: 28.4 }, { id: 'BAMLH0A0HYM2', value: 4.2 }],
        energy: { wti: 83.1, brent: 86.4, natgas: 2.4 },
        tg: { posts: 9, urgent: [{ text: 'Border clash intensifying near corridor.' }] },
        ideas: [{ type: 'long', title: 'Long defense basket' }],
      },
      delta: { summary: { direction: 'risk-off', totalChanges: 7, criticalChanges: 2 } },
      now: '2026-04-19T17:30:00.000Z',
    });

    const telegram = formatTelegramBrief(snapshot);
    const discord = formatDiscordBrief(snapshot);

    assert.match(telegram, /VIX: 28.4/);
    assert.match(telegram, /Long defense basket/);
    assert.match(discord, /RISK-OFF/);
    assert.match(discord, /OSINT: 1 urgent signals, 9 total posts/);
  });
});

describe('shared alert logic', () => {
  it('filters suppressed and semantically duplicated signals', () => {
    const signal = { text: 'Strike reported at 12:30 with 4.2% move' };
    const memory = {
      isSignalSuppressed: (key) => key.startsWith('tg:blocked'),
    };
    const contentHashes = {};

    const first = getNewSignals({ signals: { new: [signal] } }, memory, contentHashes, 'tg');
    assert.equal(first.length, 1);

    contentHashes[contentHash(signal)] = new Date().toISOString();
    const second = getNewSignals({ signals: { new: [signal] } }, memory, contentHashes, 'tg');
    assert.equal(second.length, 0);
  });

  it('uses shared rule-based evaluation for nuclear anomalies', () => {
    const evaluation = ruleBasedEvaluation(
      [{ key: 'nuke_anomaly', severity: 'critical' }],
      { summary: { direction: 'risk-off', totalChanges: 1, criticalChanges: 1 } },
    );

    assert.equal(evaluation.shouldAlert, true);
    assert.equal(evaluation.tier, 'FLASH');
    assert.match(evaluation.reason, /anomaly/i);
  });
});

describe('DiscordAlerter configuration modes', () => {
  it('does not start a bot client in webhook-only mode', async () => {
    const alerter = new DiscordAlerter({ webhookUrl: 'https://discord.test/webhook' });

    assert.equal(alerter.isConfigured, true);
    assert.equal(alerter.hasWebhookConfigured, true);
    assert.equal(alerter.hasBotConfigured, false);

    await alerter.start();

    assert.equal(alerter._client, null);
  });
});
