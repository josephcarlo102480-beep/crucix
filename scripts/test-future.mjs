#!/usr/bin/env node
// Run the test suite with the clock shifted forward to catch fixtures that
// will expire (hard-coded TLE epochs, fixed "recent" dates, and so on).
//
//   npm run test:future               # +30, +90, +180 and +365 days
//   npm run test:future -- 45 400     # custom shifts, in days
//
// Exit code 1 if any shift has failures.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shim = pathToFileURL(join(root, 'test', 'support', 'clock-shift.mjs')).href;
const files = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name));

const shifts = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (!shifts.length) shifts.push(30, 90, 180, 365);

let failedAny = false;
for (const days of shifts) {
  const result = spawnSync(process.execPath, ['--import', shim, '--test', '--test-reporter=tap', ...files], {
    cwd: root,
    env: { ...process.env, CRUCIX_CLOCK_SHIFT_DAYS: String(days) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = result.stdout || '';
  const count = (label) => Number(out.match(new RegExp(`^# ${label} (\\d+)`, 'm'))?.[1] ?? NaN);
  const pass = count('pass');
  const fail = count('fail');
  // Leaf failures only: suite lines repeat their children's failures.
  const failures = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)]
    .map(m => m[1])
    .filter((name, i, all) => all.indexOf(name) === i);

  const when = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const ok = result.status === 0 && fail === 0;
  failedAny ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} +${days}d (${when}): ${pass} pass, ${fail} fail`);
  if (!ok) {
    for (const name of failures) console.log(`       - ${name}`);
    if (!Number.isFinite(fail)) console.log(result.stderr?.slice(-2000) || '(no output)');
  }
}

process.exit(failedAny ? 1 : 0);
