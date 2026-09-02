import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFileSync, atomicWriteJsonSync, atomicWriteFile, atomicWriteJson, readJsonSync,
} from '../lib/util/fs.mjs';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'crucix-fs-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const noTmpLeftovers = () => assert.deepEqual(readdirSync(dir).filter(f => f.includes('.tmp-')), []);

describe('atomicWriteFileSync', () => {
  it('writes the file and leaves no tmp file behind', () => {
    const p = join(dir, 'plain.txt');
    atomicWriteFileSync(p, 'hello');
    assert.equal(readFileSync(p, 'utf-8'), 'hello');
    noTmpLeftovers();
  });

  it('creates missing parent directories', () => {
    const p = join(dir, 'nested', 'deeper', 'file.txt');
    atomicWriteFileSync(p, 'x');
    assert.equal(readFileSync(p, 'utf-8'), 'x');
  });

  it('overwrites an existing file', () => {
    const p = join(dir, 'over.txt');
    writeFileSync(p, 'old');
    atomicWriteFileSync(p, 'new');
    assert.equal(readFileSync(p, 'utf-8'), 'new');
    noTmpLeftovers();
  });

  it('honours an explicit mode', () => {
    const p = join(dir, 'moded.txt');
    atomicWriteFileSync(p, 'x', { mode: 0o600 });
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

describe('atomicWriteJsonSync', () => {
  it('produces valid JSON', () => {
    const p = join(dir, 'data.json');
    atomicWriteJsonSync(p, { a: 1, b: [2, 3] });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { a: 1, b: [2, 3] });
    noTmpLeftovers();
  });

  it('pretty-prints when asked', () => {
    const p = join(dir, 'pretty.json');
    atomicWriteJsonSync(p, { a: 1 }, { pretty: true });
    const text = readFileSync(p, 'utf-8');
    assert.ok(text.includes('\n  "a": 1'), text);
    assert.deepEqual(JSON.parse(text), { a: 1 });
  });
});

describe('async atomic writes', () => {
  it('atomicWriteFile writes and cleans up', async () => {
    const p = join(dir, 'async.txt');
    await atomicWriteFile(p, 'async-hello');
    assert.equal(readFileSync(p, 'utf-8'), 'async-hello');
    noTmpLeftovers();
  });

  it('atomicWriteJson writes valid JSON', async () => {
    const p = join(dir, 'async.json');
    await atomicWriteJson(p, { ok: true }, { pretty: true });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { ok: true });
    noTmpLeftovers();
  });

  it('creates missing parent directories', async () => {
    const p = join(dir, 'async-nested', 'f.json');
    await atomicWriteJson(p, { n: 1 });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { n: 1 });
  });
});

describe('readJsonSync', () => {
  it('reads a written object back', () => {
    const p = join(dir, 'round.json');
    atomicWriteJsonSync(p, { x: 'y' });
    assert.deepEqual(readJsonSync(p, null), { x: 'y' });
  });

  it('returns the fallback for a missing file', () => {
    assert.deepEqual(readJsonSync(join(dir, 'nope.json'), { fallback: true }), { fallback: true });
  });

  it('returns the fallback for corrupt JSON', () => {
    const p = join(dir, 'corrupt.json');
    writeFileSync(p, '{"half":');
    assert.equal(readJsonSync(p, 'FB'), 'FB');
  });

  it('returns the fallback for valid JSON that is not an object', () => {
    const p = join(dir, 'scalar.json');
    writeFileSync(p, '42');
    assert.equal(readJsonSync(p, 'FB'), 'FB');
    writeFileSync(p, 'null');
    assert.equal(readJsonSync(p, 'FB'), 'FB');
  });

  it('accepts arrays', () => {
    const p = join(dir, 'arr.json');
    writeFileSync(p, '[1,2]');
    assert.deepEqual(readJsonSync(p, null), [1, 2]);
  });

  it('never throws', () => {
    assert.equal(readJsonSync(dir, 'FB'), 'FB'); // a directory
  });
});
