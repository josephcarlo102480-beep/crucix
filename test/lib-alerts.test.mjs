// Discord alerter + shared alert evaluation — no network, stubbed client.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAlerter } from '../lib/alerts/discord.mjs';
import { evaluateAlertDecision, isValidAlertEvaluation } from '../lib/alerts/shared.mjs';

function delta(overrides = {}) {
  return {
    summary: { totalChanges: 2, criticalChanges: 1, direction: 'risk-off' },
    signals: {
      new: [{ key: 'nuke_anomaly', reason: 'Nuclear anomaly detected', severity: 'critical' }],
      escalated: [{ key: 'vix', label: 'VIX', from: 15, to: 30, direction: 'up', severity: 'critical', pctChange: 100 }],
    },
    ...overrides,
  };
}

function stubMemory() {
  const alerted = {};
  return {
    alerted,
    markManyCalls: 0,
    isSignalSuppressed: () => false,
    getAlertedSignals: () => alerted,
    markAsAlerted(key, ts) { alerted[key] = ts; },
    markManyAsAlerted(keys, ts) {
      this.markManyCalls += 1;
      for (const key of keys) alerted[key] = ts;
    },
  };
}

/** Alerter wired to a webhook, with sendMessage captured instead of sent. */
function stubAlerter({ onSend } = {}) {
  const alerter = new DiscordAlerter({ webhookUrl: 'https://discord.test/webhook' });
  alerter.sent = [];
  alerter.sendMessage = async (content, embeds) => {
    alerter.sent.push({ content, embeds });
    if (onSend) await onSend();
    return true;
  };
  return alerter;
}

const llm = (text) => ({ isConfigured: true, complete: async () => ({ text }) });

describe('LLM alert JSON validation', () => {
  it('accepts a complete alert', () => {
    assert.equal(isValidAlertEvaluation({
      shouldAlert: true, tier: 'FLASH', headline: 'Something', reason: 'Because.',
    }), true);
  });

  it('rejects a missing headline, reason or tier', () => {
    const base = { shouldAlert: true, tier: 'FLASH', headline: 'H', reason: 'R' };
    assert.equal(isValidAlertEvaluation({ ...base, headline: '' }), false);
    assert.equal(isValidAlertEvaluation({ ...base, reason: '   ' }), false);
    assert.equal(isValidAlertEvaluation({ ...base, tier: 'URGENT' }), false);
    assert.equal(isValidAlertEvaluation({ ...base, tier: undefined }), false);
    assert.equal(isValidAlertEvaluation({ headline: 'H', reason: 'R', tier: 'FLASH' }), false);
  });

  it('accepts a well-formed decision not to alert', () => {
    assert.equal(isValidAlertEvaluation({ shouldAlert: false, reason: 'noise' }), true);
  });

  it('falls back to rules when the LLM returns a half-filled alert', async () => {
    const evaluation = await evaluateAlertDecision({
      llmProvider: llm(JSON.stringify({ shouldAlert: true, tier: 'FLASH' })),
      signals: delta().signals.new,
      delta: delta(),
      logLabel: 'test',
    });
    assert.equal(evaluation._source, 'rules');
    assert.equal(evaluation.headline, 'Nuclear Anomaly Detected');
  });

  it('keeps a valid LLM alert and normalizes its tier', async () => {
    const evaluation = await evaluateAlertDecision({
      llmProvider: llm(JSON.stringify({
        shouldAlert: true, tier: 'priority', headline: 'Oil spike', reason: 'Brent +6%.',
      })),
      signals: delta().signals.escalated,
      delta: delta(),
      logLabel: 'test',
    });
    assert.equal(evaluation._source, undefined);
    assert.equal(evaluation.tier, 'PRIORITY');
    assert.equal(evaluation.headline, 'Oil spike');
  });

  it('honours a well-formed no-alert decision instead of overriding it with rules', async () => {
    const evaluation = await evaluateAlertDecision({
      llmProvider: llm(JSON.stringify({ shouldAlert: false, reason: 'Routine drift.' })),
      signals: delta().signals.new,
      delta: delta(),
      logLabel: 'test',
    });
    assert.equal(evaluation.shouldAlert, false);
    assert.equal(evaluation._source, undefined);
  });
});

describe('embed building', () => {
  it('truncates descriptions to Discord\'s 4096-character limit', () => {
    const alerter = stubAlerter();
    const embed = alerter._embed('Title', 'x'.repeat(9000), 0x00E5FF);
    assert.equal(embed.description.length, 4096);
    assert.ok(embed.description.endsWith('…'));
  });

  it('leaves a short description untouched', () => {
    const alerter = stubAlerter();
    assert.equal(alerter._embed('Title', 'short', 0).description, 'short');
  });

  it('truncates the alert embed built from a long LLM reason', () => {
    const alerter = stubAlerter();
    const embed = alerter._buildAlertEmbed(
      { headline: 'Headline', reason: 'y'.repeat(9000), confidence: 'HIGH' },
      delta(),
      'FLASH',
    );
    assert.ok(embed.description.length <= 4096);
  });
});

describe('overlapping evaluations', () => {
  it('skips a second evaluation while one is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const alerter = stubAlerter({ onSend: () => gate });
    const memory = stubMemory();

    const first = alerter.evaluateAndAlert(null, delta(), memory);
    const second = await alerter.evaluateAndAlert(null, delta(), memory);
    assert.equal(second, false, 'the overlapping call must not alert');

    release();
    assert.equal(await first, true);
    assert.equal(alerter.sent.length, 1, 'exactly one message sent');
  });

  it('accepts a new evaluation once the previous one settles', async () => {
    const alerter = stubAlerter();
    const memory = stubMemory();

    assert.equal(await alerter.evaluateAndAlert(null, delta(), memory), true);
    assert.equal(alerter._evaluation, null);
    // Second round: the signals are marked now, so nothing new remains.
    memory.isSignalSuppressed = (key) => key in memory.alerted;
    assert.equal(await alerter.evaluateAndAlert(null, delta(), memory), false);
  });

  it('releases the in-flight slot even when the evaluation throws', async () => {
    const alerter = stubAlerter();
    alerter.sendMessage = async () => { throw new Error('discord down'); };
    await assert.rejects(() => alerter.evaluateAndAlert(null, delta(), stubMemory()), /discord down/);
    assert.equal(alerter._evaluation, null);
  });

  it('marks every alerted signal in one batched write', async () => {
    const alerter = stubAlerter();
    const memory = stubMemory();
    await alerter.evaluateAndAlert(null, delta(), memory);
    assert.equal(memory.markManyCalls, 1);
    assert.equal(Object.keys(memory.alerted).length, 2);
  });
});

describe('interaction handling', () => {
  /** Minimal stand-in for discord.js's Client event emitter. */
  function fakeClient() {
    const listeners = {};
    return {
      listeners,
      on(event, fn) { listeners[event] = fn; },
      once(event, fn) { listeners[event] = fn; },
      emit(event, payload) { return listeners[event]?.(payload); },
    };
  }

  function installHandler(alerter) {
    const client = fakeClient();
    alerter._client = client;
    // Same listener body start() installs.
    client.on('interactionCreate', async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        await alerter._handleCommand(interaction);
      } catch (err) {
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'Command failed.' });
          }
        } catch { /* reporting failure must not escape either */ }
      }
    });
    return client;
  }

  it('does not let a throwing command escape the listener', async () => {
    const alerter = stubAlerter();
    const client = installHandler(alerter);
    const edits = [];
    const interaction = {
      commandName: 'status',
      deferred: true,
      replied: false,
      isChatInputCommand: () => true,
      options: { getNumber: () => null, getString: () => null },
      deferReply: async () => {},
      reply: async () => {},
      editReply: async (payload) => { edits.push(payload); },
    };

    alerter.onCommand('status', async () => { throw new Error('handler blew up'); });
    await assert.doesNotReject(() => client.emit('interactionCreate', interaction));
    assert.equal(edits.length, 1);
    assert.match(edits[0].content, /Command failed/);
  });

  it('does not throw when the fallback editReply also fails', async () => {
    const alerter = stubAlerter();
    const client = installHandler(alerter);
    const interaction = {
      commandName: 'status',
      deferred: true,
      replied: false,
      isChatInputCommand: () => true,
      options: { getNumber: () => null, getString: () => null },
      deferReply: async () => { throw new Error('gateway gone'); },
      reply: async () => {},
      editReply: async () => { throw new Error('token expired'); },
    };

    alerter.onCommand('status', async () => 'never reached');
    await assert.doesNotReject(() => client.emit('interactionCreate', interaction));
  });

  it('formats mute and alert-history timestamps as UTC', async () => {
    const alerter = stubAlerter();
    const client = installHandler(alerter);
    const replies = [];
    const interaction = {
      commandName: 'mute',
      isChatInputCommand: () => true,
      options: { getNumber: () => 2, getString: () => null },
      reply: async (payload) => { replies.push(payload); },
      editReply: async () => {},
    };

    await client.emit('interactionCreate', interaction);
    const description = replies[0].embeds[0].description;
    assert.match(description, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  });
});
