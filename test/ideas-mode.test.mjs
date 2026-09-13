import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSweepIdeas } from '../lib/llm/ideas.mjs';

const rules = [{ title: 'rule' }];
const llm = [{ title: 'llm' }];
const now = '2026-09-13T01:00:00Z';

test('LLM off always publishes rule ideas as disabled', () => {
  const r = resolveSweepIdeas({ auto: true, llmConfigured: false, llmIdeas: llm, ruleIdeas: rules });
  assert.deepEqual(r, { ideas: rules, ideasSource: 'disabled', ideasMode: 'disabled', ideasGeneratedAt: null });
});

test('auto mode publishes fresh LLM ideas, or rules when the LLM returned nothing', () => {
  const ok = resolveSweepIdeas({ auto: true, llmConfigured: true, llmIdeas: llm, ruleIdeas: rules, now });
  assert.equal(ok.ideasSource, 'llm');
  assert.equal(ok.ideasMode, 'auto');
  assert.equal(ok.ideasGeneratedAt, '2026-09-13T01:00:00.000Z');
  const failed = resolveSweepIdeas({ auto: true, llmConfigured: true, llmIdeas: null, ruleIdeas: rules });
  assert.deepEqual(failed, { ideas: rules, ideasSource: 'llm-failed', ideasMode: 'auto', ideasGeneratedAt: null });
});

test('manual mode never calls for fresh ideas: it carries the last on-demand run forward', () => {
  const before = resolveSweepIdeas({ auto: false, llmConfigured: true, llmIdeas: llm, manualIdeas: null, ruleIdeas: rules });
  assert.deepEqual(before, { ideas: rules, ideasSource: 'manual', ideasMode: 'manual', ideasGeneratedAt: null });
  const after = resolveSweepIdeas({ auto: false, llmConfigured: true, manualIdeas: { ideas: llm, generatedAt: now }, ruleIdeas: rules });
  assert.deepEqual(after, { ideas: llm, ideasSource: 'llm', ideasMode: 'manual', ideasGeneratedAt: now });
});
