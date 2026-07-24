#!/usr/bin/env node
/**
 * browser-probe.mjs — headless browser probe for the Crucix dashboard.
 *
 * Why Firefox and not Chrome: on the Raspberry Pi, headless Chromium cannot
 * load any http(s) URL (the network service hangs; `data:` URLs work fine).
 * Firefox drives fine over WebDriver BiDi — note CDP was removed in Firefox
 * 129+, so BiDi is the only option. Needs no npm deps: Node 22 ships WebSocket.
 *
 * Runs a snippet of JS inside the real page, captures every console entry and
 * uncaught error, and optionally grabs a screenshot.
 *
 *   node scripts/browser-probe.mjs --wait-for '.nuke-clickable' probe.js
 *   node scripts/browser-probe.mjs -e "return document.title"
 *   node scripts/browser-probe.mjs --url http://127.0.0.1:3118/satellites.html \
 *        --screenshot /tmp/sats.png --settle 8000
 *
 * The program file / -e snippet is the body of an async function, so `await`
 * works at top level. Whatever it returns is JSON-serialised to stdout; return
 * a JSON string and it gets parsed for you.
 *
 * Exit codes: 0 ok · 1 harness or program failure · 2 console errors seen
 * (suppress with --allow-console-errors) · 3 the probe returned {pass:false}.
 *
 * Heads up: Firefox takes ~15-20 s to come up on the Pi, and the dashboard
 * renders asynchronously after load — use --wait-for and/or --settle rather
 * than trusting the load event.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIREFOX = process.env.FIREFOX_BIN || '/usr/bin/firefox';
const DEFAULT_URL = process.env.CRUCIX_URL || 'http://127.0.0.1:3118/';

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = {
  url: DEFAULT_URL, program: null, expr: null, screenshot: null,
  waitFor: null, settle: 3000, timeout: 120000, allowConsoleErrors: false, keepOpen: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') opt.url = argv[++i];
  else if (a === '-e' || a === '--eval') opt.expr = argv[++i];
  else if (a === '--screenshot') opt.screenshot = argv[++i];
  else if (a === '--wait-for') opt.waitFor = argv[++i];
  else if (a === '--settle') opt.settle = Number(argv[++i]);
  else if (a === '--timeout') opt.timeout = Number(argv[++i]);
  else if (a === '--allow-console-errors') opt.allowConsoleErrors = true;
  else if (a === '--keep-open') opt.keepOpen = true;
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
    process.exit(0);
  } else if (!a.startsWith('-')) opt.program = a;
  else { console.error(`unknown flag: ${a}`); process.exit(1); }
}

const body = opt.expr ?? (opt.program ? readFileSync(opt.program, 'utf8') : 'return null;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// ---- launch ---------------------------------------------------------------
const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'crucix-probe-'));
const ff = spawn(FIREFOX, [
  '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port),
], { stdio: ['ignore', 'ignore', 'pipe'] });

let ffErr = '';
ff.stderr.on('data', d => { ffErr += d.toString(); });
ff.on('error', e => { console.error(`cannot spawn ${FIREFOX}: ${e.message}`); process.exit(1); });

async function connect() {
  // Firefox needs ~15-20 s to open the BiDi port on a Pi.
  for (let i = 0; i < 60; i++) {
    if (ff.exitCode !== null) throw new Error(`firefox exited (${ff.exitCode})\n${ffErr.slice(-2000)}`);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('refused')), { once: true });
      });
      return ws;
    } catch { await sleep(1000); }
  }
  throw new Error(`no BiDi connection on port ${port}\n${ffErr.slice(-2000)}`);
}

// ---- BiDi plumbing --------------------------------------------------------
let ws, nextId = 1;
const pending = new Map();
const console_ = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`BiDi timeout: ${method}`));
    }, opt.timeout);
  });
}

let out = { ok: false };
try {
  ws = await connect();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.type === 'error' ? reject(new Error(JSON.stringify(msg))) : resolve(msg.result);
    } else if (msg.method === 'log.entryAdded') {
      const e = msg.params;
      console_.push({
        level: e.level,
        text: e.text,
        source: e.stackTrace?.callFrames?.slice(0, 4)
          .map(f => `${f.functionName || '<anon>'}@${f.lineNumber}:${f.columnNumber}`) ?? [],
      });
    }
  });

  await send('session.new', { capabilities: {} });
  await send('session.subscribe', { events: ['log.entryAdded'] });
  const context = (await send('browsingContext.getTree', {})).contexts[0].context;
  await send('browsingContext.navigate', { context, url: opt.url, wait: 'complete' });

  const evaluate = async (expression) => send('script.evaluate', {
    expression, target: { context }, awaitPromise: true, resultOwnership: 'none',
  });

  if (opt.waitFor) {
    const found = await evaluate(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelector(${JSON.stringify(opt.waitFor)})) return true;
        await new Promise(r => setTimeout(r, 1000));
      }
      return false;
    })()`);
    if (found.result?.value !== true) throw new Error(`--wait-for never matched: ${opt.waitFor}`);
  }
  if (opt.settle > 0) await sleep(opt.settle);

  // Stringify in-page: BiDi otherwise hands back its own remote-value format
  // ([["k",{type,value}],...]) instead of a plain object.
  const res = await evaluate(`(async () => {
    const v = await (async () => { ${body} })();
    try { return JSON.stringify(v === undefined ? null : v); } catch { return JSON.stringify(String(v)); }
  })()`);
  if (res.type === 'exception') {
    out = { ok: false, exception: res.exceptionDetails?.text, stack: res.exceptionDetails?.stackTrace };
  } else {
    let parsed = res.result?.value;
    // Twice: once to undo the wrapper, again if the probe itself returned JSON text.
    for (let i = 0; i < 2 && typeof parsed === 'string'; i++) {
      try { parsed = JSON.parse(parsed); } catch { break; }
    }
    out = { ok: true, result: parsed };
  }

  if (opt.screenshot) {
    const shot = await send('browsingContext.captureScreenshot', { context });
    writeFileSync(opt.screenshot, Buffer.from(shot.data, 'base64'));
    out.screenshot = opt.screenshot;
  }
} catch (e) {
  out = { ok: false, error: String(e.message || e) };
}

// ---- report ---------------------------------------------------------------
const errors = console_.filter(e => e.level === 'error');
// A probe that returns {pass:false} has failed its own assertions, even though
// the harness itself ran fine — surface that as a non-zero exit for CI.
const failed = out.ok && out.result && typeof out.result === 'object' && out.result.pass === false;
console.log(JSON.stringify({ url: opt.url, console: console_, consoleErrors: errors.length, ...out }, null, 2));

try { ws?.close(); } catch { /* already gone */ }
if (!opt.keepOpen) {
  ff.kill('SIGKILL');
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(!out.ok ? 1 : failed ? 3 : (errors.length && !opt.allowConsoleErrors) ? 2 : 0);
