// Atomic file writes + forgiving JSON reads.
//
// Writes go to a sibling temp file, are fsync'd, then renamed over the target.
// A reader therefore sees either the old file or the complete new one — never a
// half-written file, even if the Pi loses power mid-write.

import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync,
  readFileSync, existsSync, unlinkSync,
} from 'node:fs';
import { open as openAsync, mkdir as mkdirAsync, rename as renameAsync, unlink as unlinkAsync } from 'node:fs/promises';
import { dirname } from 'node:path';

function tmpPathFor(path) {
  return `${path}.tmp-${process.pid}`;
}

function ensureDirSync(path) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write `data` to `path` atomically (temp file + fsync + rename). */
export function atomicWriteFileSync(path, data, { mode } = {}) {
  ensureDirSync(path);
  const tmp = tmpPathFor(path);
  let fd;
  try {
    fd = openSync(tmp, 'w', mode ?? 0o666);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  return path;
}

/** Serialise `value` and write it atomically. */
export function atomicWriteJsonSync(path, value, { pretty = false } = {}) {
  return atomicWriteFileSync(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
}

async function ensureDir(path) {
  const dir = dirname(path);
  if (dir) await mkdirAsync(dir, { recursive: true }).catch(() => {});
}

/** Async atomic write. */
export async function atomicWriteFile(path, data, { mode } = {}) {
  await ensureDir(path);
  const tmp = tmpPathFor(path);
  let handle;
  try {
    handle = await openAsync(tmp, 'w', mode ?? 0o666);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameAsync(tmp, path);
  } catch (e) {
    if (handle) { try { await handle.close(); } catch { /* already closed */ } }
    await unlinkAsync(tmp).catch(() => {});
    throw e;
  }
  return path;
}

/** Async atomic JSON write. */
export async function atomicWriteJson(path, value, { pretty = false } = {}) {
  return atomicWriteFile(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
}

/** Read+parse JSON, returning `fallback` for missing, corrupt or non-object files. */
export function readJsonSync(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}
