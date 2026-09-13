#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { timingSafeEqual } from 'crypto';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { atomicWriteJsonSync } from './lib/util/fs.mjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { answerDashboardQuestion, validateAskQuestion } from './lib/llm/ask.mjs';
import { getSatellitePassContext } from './lib/space/satellitePasses.mjs';
import { generateLLMIdeas, resolveSweepIdeas } from './lib/llm/ideas.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import {
  buildBriefSnapshot,
  buildStatusSnapshot,
  formatDiscordBrief,
  formatDiscordStatus,
} from './lib/bot/messages.mjs';
// --- Isolated OSINT modules (ported from OSIRIS) ---
import cctvRouter, { warmCctv } from './services/cctv/cctvRouter.mjs';
import airwatchRouter, { warmAirwatch, stopAirwatch } from './services/airwatch/airwatchRouter.mjs';
import tleRouter from './services/space/tleRouter.mjs';
import { warmTle, stopTleWarm } from './services/space/tleCatalog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let currentRaw = null;     // Raw unsynthesized sweep output (full source data for Ask AI)
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();
let sweepTimer = null;
let httpServer = null;
let shuttingDown = false;
let askRequestsInFlight = 0;
let ideasGenerationInFlight = false;
let manualIdeas = null;   // { ideas, generatedAt, model } from the last on-demand LLM run
const askRateBuckets = new Map();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR, {
  thresholds: config.delta.thresholds,
  maxBaselineAgeMs: config.refreshIntervalMinutes * 2.5 * 60 * 1000,
});

// === LLM + Discord ===
const llmProvider = createLLMProvider(config.llm);
const discordAlerter = new DiscordAlerter(config.discord || {});
let integrationsStarted = false;

function getStatusSnapshot() {
  return buildStatusSnapshot({
    startTime,
    currentData,
    llmProvider,
    lastSweepTime,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    sweepInProgress,
    sseClientCount: sseClients.size,
    port: config.port,
  });
}

function getBriefSnapshot() {
  return buildBriefSnapshot({
    currentData,
    delta: memory.getLastDelta(),
  });
}

function initializeIntegrations() {
  if (integrationsStarted) return;
  integrationsStarted = true;

  if (llmProvider?.isConfigured) {
    console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
  } else if (llmProvider) {
    console.warn(`[Crucix] LLM provider "${llmProvider.name}" selected but credentials are missing. LLM features disabled.`);
  }
  // === Discord Bot ===
  if (discordAlerter.isConfigured) {
    console.log('[Crucix] Discord alerts enabled');

    // ─── Two-Way Bot Commands ─────────────────────────────────────────────

    discordAlerter.onCommand('status', async () => {
      return formatDiscordStatus(getStatusSnapshot());
    });

    discordAlerter.onCommand('sweep', async () => {
      if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
      runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
      return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
    });

    discordAlerter.onCommand('brief', async () => {
      if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';
      return formatDiscordBrief(getBriefSnapshot());
    });

    discordAlerter.onCommand('portfolio', async () => {
      return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
    });

    // Start the Discord bot (non-blocking — connection happens async)
    discordAlerter.start().catch(err => {
      console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
    });
  }
}

// === Express Server ===
const app = express();
app.disable('x-powered-by');
// Only a proxy on this machine may set X-Forwarded-For; req.ip then reflects the real client.
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://d3js.org https://unpkg.com https://cdn.jsdelivr.net https://esm.sh",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: http: https:",
      "media-src 'self' blob: http: https:",
      "connect-src 'self' http: https: ws: wss:",
      "frame-src http: https:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(join(ROOT, 'dashboard/public')));

// --- Isolated OSINT module routers (ported from OSIRIS) ---
app.use('/api/cctv', cctvRouter);
app.use('/api/airwatch', airwatchRouter);
app.use('/api/tle', tleRouter);

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    try {
      const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
      let html = readFileSync(htmlPath, 'utf-8');

      // Inject locale data into the HTML
      const locale = getLocale();
      const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
      html = html.replace('</head>', `${localeScript}\n</head>`);

      res.type('html').send(html);
    } catch (err) {
      console.error('[Crucix] Failed to render dashboard shell:', err?.stack || err?.message || err);
      res.status(500).type('text').send('Crucix dashboard shell failed to render. Check the server console for details.');
    }
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress', sweepInProgress, sweepStartedAt });
  res.json({ ...currentData, runtime: { sweepInProgress, refreshIntervalMinutes: config.refreshIntervalMinutes } });
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!llmProvider?.isConfigured,
    llmProvider: llmProvider?.name || null,
    llmModel: llmProvider?.model || null,
    ideasMode: !llmProvider?.isConfigured ? 'disabled' : config.llm.ideasAuto ? 'auto' : 'manual',
    askAiRequiresToken: !isLocalRequest(req),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
  });
});

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^::ffff:/, '');
  return h === '::1' || h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// True only when the server is bound to loopback AND this particular request
// came straight from loopback without passing through a proxy or tunnel.
// A reverse proxy in front of a 127.0.0.1 bind must not inherit the bypass.
function isLocalRequest(req) {
  if (!isLoopbackHost(config.host)) return false;
  const forwarded = Boolean(req.get('x-forwarded-for') || req.get('forwarded') || req.get('x-real-ip'));
  return !forwarded && isLoopbackHost(req.socket?.remoteAddress);
}

function tokensEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function getRequestToken(req) {
  const authorization = String(req.get('authorization') || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(req.get('x-crucix-api-token') || '').trim();
}

function isAskRequestAuthorized(host, expectedToken, actualToken, client = {}) {
  const { remoteAddress = '127.0.0.1', forwarded = false } = client;
  const local = isLoopbackHost(host) && !forwarded && isLoopbackHost(remoteAddress);
  return local || tokensEqual(actualToken, expectedToken);
}

function authorizeAskRequest(req, res, next) {
  if (isLocalRequest(req)) return next();
  if (!config.api.token) {
    return res.status(503).json({
      error: 'Ask AI is disabled on non-loopback bindings until CRUCIX_API_TOKEN is configured.',
    });
  }
  if (!tokensEqual(getRequestToken(req), config.api.token)) {
    return res.status(401).json({ error: 'A valid Crucix API token is required.' });
  }
  next();
}

function rateLimitAskRequest(req, res, next) {
  const now = Date.now();
  const windowMs = config.api.askRateLimitWindowMinutes * 60 * 1000;
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const bucket = (askRateBuckets.get(key) || []).filter(timestamp => now - timestamp < windowMs);
  if (bucket.length >= config.api.askRateLimitMax) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - bucket[0])) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Ask AI rate limit exceeded. Try again later.' });
  }
  bucket.push(now);
  askRateBuckets.set(key, bucket);
  if (askRateBuckets.size > 500) {
    for (const [bucketKey, timestamps] of askRateBuckets) {
      if (!timestamps.some(timestamp => now - timestamp < windowMs)) askRateBuckets.delete(bucketKey);
    }
  }
  next();
}

// API: ask the configured OpenAI model about the current dashboard, with web search.
app.post('/api/ask', authorizeAskRequest, rateLimitAskRequest, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!currentData) {
    return res.status(503).json({ error: 'No data yet — first sweep in progress', sweepInProgress, sweepStartedAt });
  }

  const validation = validateAskQuestion(req.body?.question);
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  if (!llmProvider?.isConfigured) {
    return res.status(503).json({ error: 'LLM is not configured. Set LLM_PROVIDER=openai and OPENAI_API_KEY or LLM_API_KEY.' });
  }

  if (llmProvider.name !== 'openai') {
    return res.status(400).json({ error: 'Ask AI with internet search currently requires LLM_PROVIDER=openai.' });
  }

  if (askRequestsInFlight >= config.api.askMaxConcurrent) {
    res.set('Retry-After', '5');
    return res.status(429).json({ error: 'Ask AI is busy. Try again in a few seconds.' });
  }

  askRequestsInFlight++;
  try {
    const result = await answerDashboardQuestion(llmProvider, currentData, validation.question, currentRaw);
    res.json(result);
  } catch (err) {
    console.error('[Crucix] Ask AI failed:', err?.message || err);
    res.status(502).json({ error: err?.message || 'Ask AI failed' });
  } finally {
    askRequestsInFlight--;
  }
});

// API: generate LLM trade ideas on demand (the dashboard's Generate button).
// Same loopback/token gate and rate limit as Ask AI; one generation at a time.
app.post('/api/ideas/generate', authorizeAskRequest, rateLimitAskRequest, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!currentData) {
    return res.status(503).json({ error: 'No data yet — first sweep in progress', sweepInProgress, sweepStartedAt });
  }
  if (!llmProvider?.isConfigured) {
    return res.status(503).json({ error: 'LLM is not configured. Set LLM_PROVIDER and an API key in .env.' });
  }
  if (ideasGenerationInFlight) {
    res.set('Retry-After', '10');
    return res.status(429).json({ error: 'Idea generation is already running. Try again shortly.' });
  }
  ideasGenerationInFlight = true;
  try {
    console.log(`[Crucix] Generating LLM trade ideas on demand (${llmProvider.name} ${llmProvider.model || ''})...`);
    const previousIdeas = memory.getLastRun()?.ideas || [];
    const ideas = await generateLLMIdeas(llmProvider, currentData, currentData.delta || null, previousIdeas);
    if (!ideas || !ideas.length) {
      return res.status(502).json({ error: 'The LLM returned no usable ideas. Check the service log for the provider error.' });
    }
    const generatedAt = new Date().toISOString();
    manualIdeas = { ideas, generatedAt, model: llmProvider.model || null };
    currentData = { ...currentData, ideas, ideasSource: 'llm', ideasGeneratedAt: generatedAt,
      ideasMode: config.llm.ideasAuto ? 'auto' : 'manual' };
    memory.updateLastRunIdeas(ideas);
    broadcast({ type: 'update', data: currentData });
    console.log(`[Crucix] On-demand LLM generated ${ideas.length} ideas`);
    res.json({ ideas, generatedAt, model: llmProvider.model || null, ideasSource: 'llm' });
  } catch (err) {
    console.error('[Crucix] On-demand ideas failed:', err?.message || err);
    res.status(502).json({ error: err?.message || 'Idea generation failed' });
  } finally {
    ideasGenerationInFlight = false;
  }
});

// API: local satellite pass calculations used by Ask AI and the satellite tracker.
app.get('/api/satellite-passes', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : '';
    if (zip && !/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'zip must be a 5-digit US ZIP code' });
    const hours = Number.parseInt(req.query.hours || '12', 10);
    const result = await getSatellitePassContext(zip, {
      hoursAhead: Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24) : 12,
    });
    res.json(result);
  } catch (err) {
    console.error('[Crucix] Satellite pass calculation failed:', err?.message || err);
    res.status(502).json({ error: err?.message || 'Satellite pass calculation failed' });
  }
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// SSE: live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', sweepInProgress })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Final error handler: never leak a stack trace to the client. Body-parser
// errors (bad JSON, oversized body) carry a status; anything else is a 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number.isInteger(err?.status || err?.statusCode) ? (err.status || err.statusCode) : 500;
  if (status >= 500) console.error('[Crucix] Unhandled route error:', err?.stack || err?.message || err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err?.message || 'Bad request') });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// SSE keep-alive: sweeps are 15 min apart, long enough for proxies/tunnels to
// drop an idle connection. A comment line every 30s keeps streams open.
// unref() so importing this module (tests) doesn't hold the process alive.
const sseHeartbeatTimer = setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': keep-alive\n\n'); } catch { sseClients.delete(client); }
  }
}, 30_000);
sseHeartbeatTimer.unref();

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing(currentData?.health || []);

    // 2. Save to runs/latest.json
    atomicWriteJsonSync(join(RUNS_DIR, 'latest.json'), rawData, { pretty: true });
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const previousIdeas = memory.getLastRun()?.ideas || [];
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

    // 5. LLM-powered trade ideas — isolated so failures don't kill sweep.
    // Falls back to rule-based generateIdeas() when the LLM is off or errors.
    const ruleIdeas = () => {
      try { return generateIdeas(synthesized); } catch { return []; }
    };
    const llmConfigured = !!llmProvider?.isConfigured;
    let llmIdeas = null;
    if (llmConfigured && config.llm.ideasAuto) {
      try {
        console.log('[Crucix] Generating LLM trade ideas...');
        llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
        else console.log('[Crucix] LLM returned no ideas — using rule-based fallback');
      } catch (llmErr) {
        console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
      }
    }
    Object.assign(synthesized, resolveSweepIdeas({
      auto: config.llm.ideasAuto, llmConfigured, llmIdeas, manualIdeas, ruleIdeas: ruleIdeas(),
    }));
    memory.updateLastRunIdeas(synthesized.ideas);

    // 6. Alert evaluation — Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;
    currentRaw = rawData;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.baselineReset) console.log('[Crucix] Delta baseline reset:', delta.baselineResetReason || 'The prior sweep was stale');
    else if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// === Startup ===
async function start() {
  initializeIntegrations();

  const port = config.port;
  const displayHost = isLoopbackHost(config.host) ? config.host : 'localhost';

  const discordStatus = config.discord?.botToken
    ? 'enabled'
    : config.discord?.webhookUrl ? 'webhook only' : 'disabled';
  const llmStatus = llmProvider?.isConfigured
    ? `${llmProvider.name} (${llmProvider.model})`
    : config.llm.provider ? `${config.llm.provider} (missing credentials)` : 'disabled';

  const lines = [
    '           CRUCIX INTELLIGENCE ENGINE         ',
    '          Local Palantir · 25 Sources         ',
    null, // separator
    `  Dashboard:  http://${displayHost}:${port}`,
    `  Health:     http://${displayHost}:${port}/api/health`,
    `  Refresh:    Every ${config.refreshIntervalMinutes} min`,
    `  LLM:        ${llmStatus}`,
    `  Discord:    ${discordStatus}`,
  ];
  const INNER = Math.max(46, ...lines.filter(Boolean).map(s => s.length + 2));
  const out = lines.map(l =>
    l === null
      ? `  ╠${'═'.repeat(INNER)}╣`
      : `  ║${l.padEnd(INNER, ' ')}║`
  );
  console.log(['', `  ╔${'═'.repeat(INNER)}╗`, ...out, `  ╚${'═'.repeat(INNER)}╝`].join('\n'));

  httpServer = app.listen(port, config.host);

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Crucix]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Crucix] Or change PORT in .env\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  httpServer.on('listening', async () => {
    console.log(`[Crucix] Server running on http://${displayHost}:${port} (bound to ${config.host})`);

    // Assemble the CCTV camera list, which includes a YouTube liveness sweep
    // (fire-and-forget).
    warmCctv()
      .then(n => console.log(`[Crucix] CCTV cameras warmed (${n} live)`))
      .catch(() => {});

    // Start the AirWatch military aircraft poller (fire-and-forget).
    warmAirwatch()
      .then(ok => console.log(`[Crucix] AirWatch mil feed ${ok ? 'warmed' : 'first fetch failed (poller will keep retrying)'}`))
      .catch(() => {});

    // Pre-pull the TLE groups the satellite tracker opens with, plus the full
    // catalogue that search and the military group are mined from.
    warmTle()
      .then(() => console.log('[Crucix] TLE catalog warmed'))
      .catch(() => {});

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing);
      currentData = data;
      lastSweepTime = existing.crucix?.timestamp || null;
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch (err) {
      console.log(`[Crucix] No usable cached data loaded (${err?.message || err}) — first sweep required`);
    }

    // Auto-open browser after cached data hydration, so '/' does not unnecessarily land on loading.html.
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    if (process.env.CRUCIX_NO_BROWSER !== '1') {
      const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                      process.platform === 'darwin' ? 'open' : 'xdg-open';
      // timeout so a hung opener (e.g. xdg-open on a headless Pi) can't leave a stray child process
      exec(`${openCmd} "http://localhost:${port}"`, { timeout: 5000 }, (err) => {
        if (err) console.log('[Crucix] Could not auto-open browser:', err.message);
      });
    }

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    sweepTimer = setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);
  });
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Crucix] Received ${signal}. Shutting down...`);
  // Deadline: if a client or the Discord gateway refuses to close, exit anyway
  // (systemd would otherwise SIGKILL us after its 90 s default).
  setTimeout(() => {
    console.error('[Crucix] Shutdown deadline reached, exiting');
    process.exit(exitCode || 1);
  }, 10_000).unref();

  if (sweepTimer) clearInterval(sweepTimer);
  clearInterval(sseHeartbeatTimer);
  try { stopAirwatch(); } catch { }
  try { stopTleWarm(); } catch { }
  for (const client of sseClients) {
    try { client.end(); } catch { }
  }

  await Promise.allSettled([
    discordAlerter.stop?.(),
    new Promise((resolve) => {
      if (!httpServer) return resolve();
      httpServer.close(() => resolve());
    }),
  ]);

  process.exit(exitCode);
}

function installProcessHandlers() {
  // Graceful error handling — log full stack traces for diagnosis
  process.on('unhandledRejection', (err) => {
    console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
  });
  process.on('uncaughtException', (err) => {
    // The process state is unknown after this; exit non-zero so systemd's
    // Restart=on-failure brings up a clean instance.
    console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
    shutdown('uncaughtException', 1);
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (isMain) {
  installProcessHandlers();
  start().catch(err => {
    console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
    process.exit(1);
  });
}

export {
  app,
  isAskRequestAuthorized,
  isLoopbackHost,
  runSweepCycle,
  shutdown,
  start,
};
