// Ask AI orchestration — unit tests

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerDashboardQuestion,
  compactDashboardForAsk,
  validateAskQuestion,
} from '../lib/llm/ask.mjs';

describe('Ask AI helpers', () => {
  it('validates question input', () => {
    assert.deepEqual(validateAskQuestion('  What changed?  '), { ok: true, question: 'What changed?' });
    assert.equal(validateAskQuestion('').ok, false);
    assert.equal(validateAskQuestion('x'.repeat(1201)).ok, false);
  });

  it('compacts dashboard data with key displayed sections', () => {
    const compact = compactDashboardForAsk({
      meta: { timestamp: '2026-06-21T00:00:00Z', sourcesOk: 28 },
      ideas: [{ title: 'Oil Momentum', rationale: 'WTI up' }],
      tg: { urgent: [{ text: 'urgent post' }] },
      newsFeed: [{ headline: 'Market headline' }],
      markets: { indexes: [{ symbol: 'SPY', price: 500 }] },
    });

    assert.equal(compact.meta.sourcesOk, 28);
    assert.equal(compact.ideas[0].title, 'Oil Momentum');
    assert.equal(compact.osint.telegram.urgent[0].text, 'urgent post');
    assert.equal(compact.osint.newsFeed[0].headline, 'Market headline');
    assert.equal(compact.markets.indexes[0].symbol, 'SPY');
  });

  it('asks the provider with web search enabled', async () => {
    let captured;
    const provider = {
      complete: async (systemPrompt, userPrompt, opts) => {
        captured = { systemPrompt, userPrompt, opts };
        return {
          text: 'Dashboard answer',
          citations: [{ url: 'https://example.com', title: 'Example' }],
          webSearches: [{ query: 'example', status: 'completed' }],
          model: 'gpt-5.5',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const result = await answerDashboardQuestion(
      provider,
      { meta: { timestamp: '2026-06-21T00:00:00Z' }, tSignals: ['signal'] },
      'What matters now?',
    );

    assert.match(captured.systemPrompt, /Crucix Ask AI/);
    assert.match(captured.userPrompt, /CURRENT_CRUCIX_DASHBOARD_SNAPSHOT/);
    assert.equal(captured.opts.webSearch, true);
    assert.equal(captured.opts.reasoningEffort, 'high');
    assert.equal(captured.opts.verbosity, 'high');
    assert.equal(captured.opts.searchContextSize, 'high');
    assert.equal(captured.opts.maxTokens, 8000);
    assert.equal(result.answer, 'Dashboard answer');
    assert.equal(result.model, 'gpt-5.5');
  });
});
