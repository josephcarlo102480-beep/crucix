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

test('radiation context states normal readings and flags anomalies and rising probes', async () => {
  const { radiationSummaryForLLM } = await import('../lib/llm/ideas.mjs');
  assert.equal(radiationSummaryForLLM({}), null);

  const normal = radiationSummaryForLLM({
    nuke: [
      { site: 'Chernobyl', status: 'healthy', uSvH: 0.123, cpm: 41, anom: false },
      { site: 'Bushehr', status: 'no_coverage', uSvH: null, anom: null },
    ],
    radBackground: { medianUSvH: 0.108, stationsFresh: 1826, anomaly: false, elevatedCount: 0, risingCount: 0, rising: [] },
  });
  assert.equal(normal, 'RADIATION: sites Chernobyl=0.12µSv/h; EU background median 0.11µSv/h over 1826 stations (normal <0.30)');

  const alarm = radiationSummaryForLLM({
    nuke: [{ site: 'Zaporizhzhia', status: 'healthy', uSvH: 0.45, anom: true }],
    radBackground: { medianUSvH: 0.11, stationsFresh: 1800, anomaly: false, elevatedCount: 2, risingCount: 1,
      rising: [{ name: 'Probe X', uSvH: 0.31, baselineUSvH: 0.07 }] },
  });
  assert.match(alarm, /^RADIATION_ANOMALY: sites Zaporizhzhia=0\.45µSv\/h ANOMALY/);
  assert.match(alarm, /2 probes >=0\.5µSv\/h, 1 probes >=2x own 72h median \(top Probe X 0\.31µSv\/h vs 0\.07µSv\/h/);
});
