#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import {
  buildBriefSnapshot,
  buildStatusSnapshot,
  formatDiscordBrief,
  formatDiscordStatus,
  formatTelegramBrief,
  formatTelegramStatus,
} from './lib/bot/messages.mjs';
// --- Isolated OSINT modules (ported from OSIRIS) ---
import sanctionsRouter from './services/sanctions/sanctionsRouter.mjs';
import { warmCache as warmSanctionsCache } from './services/sanctions/ofacSanctions.mjs';
import cctvRouter from './services/cctv/cctvRouter.mjs';

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
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();
let sweepTimer = null;
let httpServer = null;
let shuttingDown = false;

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter(config.telegram);
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

  if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
  if (telegramAlerter.isConfigured) {
    console.log('[Crucix] Telegram alerts enabled');

    // ─── Two-Way Bot Commands ─────────────────────────────────────────────

    telegramAlerter.onCommand('/status', async () => {
      return formatTelegramStatus(getStatusSnapshot());
    });

    telegramAlerter.onCommand('/sweep', async () => {
      if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
      // Fire and forget — don't block the bot response
      runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
      return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
    });

    telegramAlerter.onCommand('/brief', async () => {
      if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';
      return formatTelegramBrief(getBriefSnapshot());
    });

    telegramAlerter.onCommand('/portfolio', async () => {
      return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
    });

    // Start polling for bot commands
    telegramAlerter.startPolling(config.telegram.botPollingInterval);
  }

  // === Discord Bot ===
  if (discordAlerter.isConfigured) {
    console.log('[Crucix] Discord alerts enabled');

    // Reuse the same command handlers as Telegram (DRY)
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
app.use(express.static(join(ROOT, 'dashboard/public')));

// --- Isolated OSINT module routers (ported from OSIRIS) ---
app.use('/api/sanctions', sanctionsRouter);
app.use('/api/cctv', cctvRouter);

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
  res.json(currentData);
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
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
  });
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
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

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
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

    // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Crucix] Generating LLM trade ideas...');
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) {
          synthesized.ideas = llmIdeas;
          synthesized.ideasSource = 'llm';
          console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
        } else {
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
        }
      } catch (llmErr) {
        console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
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

  const telegramStatus = config.telegram.botToken ? 'enabled' : 'disabled';
  const discordStatus = config.discord?.botToken
    ? 'enabled'
    : config.discord?.webhookUrl ? 'webhook only' : 'disabled';

  const lines = [
    '           CRUCIX INTELLIGENCE ENGINE         ',
    '          Local Palantir · 29 Sources         ',
    null, // separator
    `  Dashboard:  http://localhost:${port}`,
    `  Health:     http://localhost:${port}/api/health`,
    `  Refresh:    Every ${config.refreshIntervalMinutes} min`,
    `  LLM:        ${config.llm.provider || 'disabled'}`,
    `  Telegram:   ${telegramStatus}`,
    `  Discord:    ${discordStatus}`,
  ];
  const INNER = Math.max(46, ...lines.filter(Boolean).map(s => s.length + 2));
  const out = lines.map(l =>
    l === null
      ? `  ╠${'═'.repeat(INNER)}╣`
      : `  ║${l.padEnd(INNER, ' ')}║`
  );
  console.log(['', `  ╔${'═'.repeat(INNER)}╗`, ...out, `  ╚${'═'.repeat(INNER)}╝`].join('\n'));

  httpServer = app.listen(port);

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
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Warm the OFAC SDN sanctions cache on boot (fire-and-forget).
    warmSanctionsCache()
      .then(ok => console.log(`[Crucix] Sanctions SDN cache ${ok ? 'warmed' : 'warm-up failed (will retry on first query)'}`))
      .catch(() => {});

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing);
      currentData = data;
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
      exec(`${openCmd} "http://localhost:${port}"`, (err) => {
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Crucix] Received ${signal}. Shutting down...`);

  if (sweepTimer) clearInterval(sweepTimer);
  telegramAlerter.stopPolling?.();
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

  process.exit(0);
}

function installProcessHandlers() {
  // Graceful error handling — log full stack traces for diagnosis
  process.on('unhandledRejection', (err) => {
    console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
  });
  process.on('uncaughtException', (err) => {
    console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
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
  runSweepCycle,
  shutdown,
  start,
};
