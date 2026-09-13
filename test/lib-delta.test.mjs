// Delta engine + memory manager — storage, retention and degradation signals.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../lib/delta/memory.mjs';

const SOURCES = ['fred', 'energy', 'bls', 'acled', 'who', 'sdr'];

function snapshot(timestamp, { sourcesDown = 0, wti = 100 } = {}) {
  return {
    meta: { timestamp, sourcesOk: SOURCES.length - sourcesDown },
    fred: [],
    energy: { wti },
    bls: [],
    treasury: {},
    thermal: [],
    air: [],
    nuke: [],
    who: [],
    acled: {},
    sdr: {},
    news: [],
    health: SOURCES.map((name, i) => (i < sourcesDown ? { name, err: 'timeout' } : { name })),
  };
}

function withMemory(opts, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-delta-'));
  try {
    return fn(new MemoryManager(dir, opts), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const degradation = (delta) => (delta?.signals?.new || []).filter(s => s.key === 'source_degradation');

describe('source degradation signal', () => {
  it('resets the comparison once when source-quality rules change', () => {
    withMemory({}, memory => {
      memory.addRun(snapshot('2026-09-05T02:00:00Z'));
      const data = snapshot('2026-09-05T02:15:00Z', { sourcesDown: 4 });
      data.meta.dataQualityVersion = 1;
      const delta = memory.addRun(data);
      assert.equal(delta.baselineReset, true);
      assert.match(delta.baselineResetReason, /rules updated/);
      assert.equal(delta.summary.totalChanges, 0);
      data.meta.timestamp = '2026-09-05T02:30:00Z';
      assert.equal(memory.addRun(data).baselineReset, undefined);
    });
  });
  it('does not re-fire when the same sources stay down', () => {
    withMemory({}, (memory) => {
      memory.addRun(snapshot('2026-07-09T00:00:00.000Z', { sourcesDown: 4 }));
      const delta = memory.addRun(snapshot('2026-07-09T00:15:00.000Z', { sourcesDown: 4 }));
      assert.equal(degradation(delta).length, 0, 'a steady outage is not a new degradation');
    });
  });

  it('fires when the number of failing sources jumps', () => {
    withMemory({}, (memory) => {
      memory.addRun(snapshot('2026-07-09T00:00:00.000Z', { sourcesDown: 1 }));
      const delta = memory.addRun(snapshot('2026-07-09T00:15:00.000Z', { sourcesDown: 4 }));
      const signals = degradation(delta);
      assert.equal(signals.length, 1);
      assert.match(signals[0].reason, /3 additional sources failing \(4 total down\)/);
    });
  });

  it('keeps source health in the compacted record it diffs against', () => {
    withMemory({}, (memory) => {
      memory.addRun(snapshot('2026-07-09T00:00:00.000Z', { sourcesDown: 2 }));
      const stored = memory.getLastRun();
      assert.equal(stored.sourcesDown, 2);
      assert.equal(stored.health.length, SOURCES.length);
      assert.equal(stored.health.filter(h => h.err).length, 2);
    });
  });
});

describe('hot memory structure validation', () => {
  it('normalizes a null alertedSignals instead of trusting typeof null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crucix-hot-'));
    try {
      mkdirSync(join(dir, 'memory'), { recursive: true });
      writeFileSync(
        join(dir, 'memory', 'hot.json'),
        JSON.stringify({ runs: [], alertedSignals: null }),
      );

      const memory = new MemoryManager(dir);
      assert.deepEqual(memory.getAlertedSignals(), {});
      assert.equal(memory.isSignalSuppressed('anything'), false);
      memory.markAsAlerted('vix');
      assert.ok(memory.getAlertedSignals().vix);
      assert.equal(memory.isSignalSuppressed('vix'), true); // now inside its cooldown
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cold storage', () => {
  const fillHot = (memory) => {
    for (let i = 0; i < 4; i += 1) {
      memory.addRun(snapshot(`2026-07-09T0${i}:00:00.000Z`));
    }
  };

  it('resets a cold file that does not hold an array', () => {
    withMemory({}, (memory, dir) => {
      const coldDir = join(dir, 'memory', 'cold');
      const today = new Date().toISOString().split('T')[0];
      const coldPath = join(coldDir, `${today}.json`);
      writeFileSync(coldPath, JSON.stringify({ notAnArray: true }));

      assert.doesNotThrow(() => fillHot(memory));

      const archived = JSON.parse(readFileSync(coldPath, 'utf8'));
      assert.ok(Array.isArray(archived));
      assert.equal(archived.length, 1);
    });
  });

  it('survives a cold file that is not valid JSON', () => {
    withMemory({}, (memory, dir) => {
      const today = new Date().toISOString().split('T')[0];
      const coldPath = join(dir, 'memory', 'cold', `${today}.json`);
      writeFileSync(coldPath, '{ this is not json');

      assert.doesNotThrow(() => fillHot(memory));
      assert.ok(Array.isArray(JSON.parse(readFileSync(coldPath, 'utf8'))));
    });
  });

  it('deletes cold files past the retention window', () => {
    withMemory({ coldRetentionDays: 30 }, (memory, dir) => {
      const coldDir = join(dir, 'memory', 'cold');
      const dayKey = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().split('T')[0];
      const old = join(coldDir, `${dayKey(45)}.json`);
      const recent = join(coldDir, `${dayKey(3)}.json`);
      const unrelated = join(coldDir, 'notes.txt');
      writeFileSync(old, '[]');
      writeFileSync(recent, '[]');
      writeFileSync(unrelated, 'keep me');

      fillHot(memory);

      assert.equal(existsSync(old), false, 'a 45-day-old cold file should be pruned');
      assert.equal(existsSync(recent), true, 'a 3-day-old cold file should be kept');
      assert.equal(existsSync(unrelated), true, 'non-cold files are left alone');
    });
  });

  it('keeps everything when retention is disabled', () => {
    withMemory({ coldRetentionDays: 0 }, (memory, dir) => {
      const old = join(dir, 'memory', 'cold', '2020-01-01.json');
      writeFileSync(old, '[]');
      fillHot(memory);
      assert.equal(existsSync(old), true);
    });
  });
});

describe('batched alert marking', () => {
  it('marks every key and writes hot memory once', () => {
    withMemory({}, (memory) => {
      let saves = 0;
      const realSave = memory._saveHot.bind(memory);
      memory._saveHot = () => { saves += 1; realSave(); };

      memory.markManyAsAlerted(['a', 'b', 'c'], '2026-07-09T00:00:00.000Z');

      assert.equal(saves, 1);
      assert.deepEqual(Object.keys(memory.getAlertedSignals()).sort(), ['a', 'b', 'c']);
      assert.equal(memory.getAlertedSignals().a.count, 1);

      memory.markManyAsAlerted(['a'], '2026-07-09T00:10:00.000Z');
      assert.equal(memory.getAlertedSignals().a.count, 2);
      assert.equal(saves, 2);
    });
  });

  it('skips the write when asked to', () => {
    withMemory({}, (memory, dir) => {
      memory.addRun(snapshot('2026-07-09T00:00:00.000Z')); // creates hot.json
      memory.markAsAlerted('deferred', '2026-07-09T00:00:00.000Z', { save: false });
      const onDisk = JSON.parse(readFileSync(join(dir, 'memory', 'hot.json'), 'utf8'));
      assert.equal(onDisk.alertedSignals.deferred, undefined);
      assert.ok(memory.getAlertedSignals().deferred);
    });
  });
});
