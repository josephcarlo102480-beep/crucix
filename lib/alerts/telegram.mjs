// Telegram Alerter v2 — Multi-tier alerts, semantic dedup, two-way bot commands
// USP feature: Crucix becomes a conversational intelligence agent via Telegram

import {
  ALERT_RATE_LIMITS,
  buildEvaluationPrompt,
  buildSignalContext,
  checkRateLimit,
  contentHash,
  evaluateAlertDecision,
  getNewSignals,
  recordAlert,
  recordContentHash,
  signalKey,
} from './shared.mjs';
import { recordTelegramUpdate } from '../telegramUpdates.mjs';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram Bot API limit for sendMessage text (bytes/characters). */
const TELEGRAM_MAX_TEXT = 4096;

// ─── Alert Tiers ────────────────────────────────────────────────────────────
// FLASH:    Immediate action required — market-moving, time-critical (e.g. war escalation, flash crash)
// PRIORITY: Important signal cluster — act within hours (e.g. rate surprise, major OSINT shift)
// ROUTINE:  Noteworthy change — FYI, no urgency (e.g. trend continuation, moderate delta)

const TIER_CONFIG = {
  FLASH: { ...ALERT_RATE_LIMITS.FLASH, emoji: '🔴', label: 'FLASH' },
  PRIORITY: { ...ALERT_RATE_LIMITS.PRIORITY, emoji: '🟡', label: 'PRIORITY' },
  ROUTINE: { ...ALERT_RATE_LIMITS.ROUTINE, emoji: '🔵', label: 'ROUTINE' },
};

// ─── Bot Commands ───────────────────────────────────────────────────────────
const COMMANDS = {
  '/status':    'Get current system health, last sweep time, source status',
  '/sweep':     'Trigger a manual sweep cycle',
  '/brief':     'Get a compact text summary of the latest intelligence',
  '/portfolio': 'Show current positions and P&L (if Alpaca connected)',
  '/alerts':    'Show recent alert history',
  '/mute':      'Mute alerts for 1h (or /mute 2h, /mute 4h)',
  '/unmute':    'Resume alerts',
  '/help':      'Show available commands',
};

export class TelegramAlerter {
  constructor({ botToken, chatId }) {
    this.botToken = botToken;
    this.chatId = chatId;
    this._alertHistory = [];     // Recent alerts for rate limiting
    this._contentHashes = {};    // Semantic dedup: hash → timestamp
    this._muteUntil = null;      // Mute timestamp
    this._lastUpdateId = 0;      // For polling bot commands
    this._commandHandlers = {};  // Registered command callbacks
    this._pollingInterval = null;
    this._pollPromise = null;
    this._botUsername = null;
  }

  get isConfigured() {
    return !!(this.botToken && this.chatId);
  }

  // ─── Core Messaging ─────────────────────────────────────────────────────

  /**
   * Send a message via Telegram Bot API. Splits at TELEGRAM_MAX_TEXT so long messages
   * (e.g. /brief) are sent in multiple messages instead of being truncated or failing.
   * @param {string} message - markdown-formatted message
   * @param {object} opts - optional: { parseMode, disablePreview, replyToMessageId, chatId }
   * @returns {Promise<{ok: boolean, messageId?: number}>}
   */
  async sendMessage(message, opts = {}) {
    if (!this.isConfigured) return { ok: false };
    const chatId = opts.chatId ?? this.chatId;
    const parseMode = opts.parseMode || 'Markdown';
    const chunks = this._chunkText(message, TELEGRAM_MAX_TEXT);

    try {
      let lastResult = { ok: false, messageId: undefined };
      for (let i = 0; i < chunks.length; i++) {
        const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunks[i],
            parse_mode: parseMode,
            disable_web_page_preview: opts.disablePreview !== false,
            ...(opts.replyToMessageId && i === 0 ? { reply_to_message_id: opts.replyToMessageId } : {}),
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          const err = await res.text().catch(() => '');
          console.error(`[Telegram] Send failed (${res.status}): ${err.substring(0, 200)}`);
          return lastResult;
        }

        const data = await res.json();
        lastResult = { ok: true, messageId: data.result?.message_id };
      }
      return lastResult;
    } catch (err) {
      console.error('[Telegram] Send error:', err.message);
      return { ok: false };
    }
  }

  /**
   * Split text into chunks of at most maxLen. Prefer breaking at newlines to avoid
   * splitting mid-Markdown.
   */
  _chunkText(text, maxLen = TELEGRAM_MAX_TEXT) {
    if (!text || text.length <= maxLen) return text ? [text] : [];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxLen, text.length);
      if (end < text.length) {
        const lastNewline = text.lastIndexOf('\n', end - 1);
        if (lastNewline > start) end = lastNewline + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  // Backward-compatible alias
  async sendAlert(message) {
    const result = await this.sendMessage(message);
    return result.ok;
  }

  // ─── Multi-Tier Alert Evaluation ────────────────────────────────────────

  /**
   * Evaluate delta signals with LLM and send tiered alert if warranted.
   * Uses semantic dedup, rate limiting, and a much richer evaluation prompt.
   */
  async evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;
    if (this._isMuted()) {
      console.log('[Telegram] Alerts muted until', new Date(this._muteUntil).toLocaleTimeString());
      return false;
    }

    // 1. Gather new signals — filter already-alerted AND semantically duplicate
    const newSignals = getNewSignals(delta, memory, this._contentHashes, 'tg');

    if (newSignals.length === 0) return false;

    const evaluation = await evaluateAlertDecision({
      llmProvider,
      signals: newSignals,
      delta,
      logLabel: 'Telegram',
    });

    if (!evaluation?.shouldAlert) {
      console.log('[Telegram] No alert —', evaluation?.reason || 'no qualifying signals');
      return false;
    }

    // 3. Validate tier and check rate limits
    const tier = TIER_CONFIG[evaluation.tier] ? evaluation.tier : 'ROUTINE';
    if (!this._checkRateLimit(tier)) {
      console.log(`[Telegram] Rate limited for tier ${tier}`);
      return false;
    }

    // 4. Format and send tiered alert
    const message = this._formatTieredAlert(evaluation, delta, tier);
    const sent = await this.sendAlert(message);

    if (sent) {
      // Mark signals as alerted with content hashing
      for (const s of newSignals) {
        const key = this._signalKey(s);
        memory.markAsAlerted(key, new Date().toISOString());
        this._recordContentHash(s);
      }
      this._recordAlert(tier);
      console.log(`[Telegram] ${tier} alert sent (${evaluation._source || 'llm'}): ${evaluation.headline}`);
    }

    return sent;
  }

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  /**
   * Register command handlers that the bot can respond to.
   * @param {string} command - e.g. '/status'
   * @param {Function} handler - async (args, messageId) => responseText
   */
  onCommand(command, handler) {
    this._commandHandlers[command.toLowerCase()] = handler;
  }

  /**
   * Start polling for incoming messages/commands.
   * Call this once during server startup.
   * @param {number} intervalMs - polling interval (default 5000ms)
   */
  startPolling(intervalMs = 5000) {
    if (!this.isConfigured) return;
    if (this._pollingInterval) return; // Already polling

    console.log('[Telegram] Bot command polling started');
    this._initializeBotCommands().catch((err) => {
      console.error('[Telegram] Command initialization failed:', err.message);
    });
    this._pollingInterval = setInterval(() => this._schedulePoll(), intervalMs);
    // Initial poll
    this._schedulePoll();
  }

  _schedulePoll() {
    if (this._pollPromise) return this._pollPromise;
    this._pollPromise = this._pollUpdates().finally(() => {
      this._pollPromise = null;
    });
    return this._pollPromise;
  }

  /**
   * Stop polling for incoming messages.
   */
  stopPolling() {
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
      console.log('[Telegram] Bot command polling stopped');
    }
  }

  async _pollUpdates() {
    try {
      const params = new URLSearchParams({
        offset: String(this._lastUpdateId + 1),
        timeout: '0',
        limit: '10',
        allowed_updates: JSON.stringify(['message', 'channel_post', 'edited_channel_post']),
      });

      const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getUpdates?${params}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return;

      const data = await res.json();
      if (!data.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        this._lastUpdateId = Math.max(this._lastUpdateId, update.update_id);
        recordTelegramUpdate(update);
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat?.id);
        // Restrict command execution to the configured chat/group only.
        if (chatId !== String(this.chatId)) continue;

        await this._handleMessage(msg);
      }
    } catch (err) {
      // Silent — polling failures are non-fatal
      if (!err.message?.includes('aborted')) {
        console.error('[Telegram] Poll error:', err.message);
      }
    }
  }

  async _handleMessage(msg) {
    const text = msg.text.trim();
    const parts = text.split(/\s+/);
    const rawCommand = parts[0].toLowerCase();
    const command = this._normalizeCommand(rawCommand);
    if (!command) return;
    const args = parts.slice(1).join(' ');
    const replyChatId = msg.chat?.id;

    // Built-in commands
    if (command === '/help') {
      const helpText = Object.entries(COMMANDS)
        .map(([cmd, desc]) => `${cmd} — ${desc}`)
        .join('\n');
      await this.sendMessage(
        `🤖 *CRUCIX BOT COMMANDS*\n\n${helpText}\n\n_Tip: Commands are case-insensitive_`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    if (command === '/mute') {
      const hours = parseFloat(args) || 1;
      this._muteUntil = Date.now() + hours * 60 * 60 * 1000;
      await this.sendMessage(
        `🔇 Alerts muted for ${hours}h — until ${new Date(this._muteUntil).toLocaleTimeString()} UTC\nUse /unmute to resume.`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    if (command === '/unmute') {
      this._muteUntil = null;
      await this.sendMessage(
        `🔔 Alerts resumed. You'll receive the next signal evaluation.`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    if (command === '/alerts') {
      const recent = this._alertHistory.slice(-10);
      if (recent.length === 0) {
        await this.sendMessage('No recent alerts.', { chatId: replyChatId, replyToMessageId: msg.message_id });
        return;
      }
      const lines = recent.map(a =>
        `${TIER_CONFIG[a.tier]?.emoji || '⚪'} ${a.tier} — ${new Date(a.timestamp).toLocaleTimeString()}`
      );
      await this.sendMessage(
        `📋 *Recent Alerts (last ${recent.length})*\n\n${lines.join('\n')}`,
        { chatId: replyChatId, replyToMessageId: msg.message_id }
      );
      return;
    }

    // Delegate to registered handlers
    const handler = this._commandHandlers[command];
    if (handler) {
      try {
        const response = await handler(args, msg.message_id);
        if (response) {
          await this.sendMessage(response, { chatId: replyChatId, replyToMessageId: msg.message_id });
        }
      } catch (err) {
        console.error(`[Telegram] Command ${command} error:`, err.message);
        await this.sendMessage(
          `❌ Command failed: ${err.message}`,
          { chatId: replyChatId, replyToMessageId: msg.message_id }
        );
      }
    }
    // Unknown commands are silently ignored to avoid spamming
  }

  async _initializeBotCommands() {
    await this._loadBotIdentity();

    const botCommands = Object.entries(COMMANDS).map(([command, description]) => ({
      command: command.replace('/', ''),
      description: description.substring(0, 256),
    }));

    // Register commands only for the configured chat to avoid global discovery.
    await this._setMyCommands(botCommands, this._buildConfiguredChatScope());
  }

  async _loadBotIdentity() {
    const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`getMe failed (${res.status}): ${err.substring(0, 200)}`);
    }
    const data = await res.json();
    if (!data.ok || !data.result?.username) {
      throw new Error('getMe returned invalid bot profile');
    }
    this._botUsername = String(data.result.username).toLowerCase();
  }

  async _setMyCommands(commands, scope = null) {
    const body = { commands };
    if (scope) body.scope = scope;

    const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`setMyCommands failed (${res.status}): ${err.substring(0, 200)}`);
    }
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`setMyCommands rejected: ${JSON.stringify(data).substring(0, 200)}`);
    }
  }

  _buildConfiguredChatScope() {
    const chatId = Number(this.chatId);
    if (!Number.isSafeInteger(chatId)) {
      throw new Error(`TELEGRAM_CHAT_ID must be a numeric chat id, got: ${this.chatId}`);
    }
    return { type: 'chat', chat_id: chatId };
  }

  _normalizeCommand(rawCommand) {
    if (!rawCommand.startsWith('/')) return null;

    const atIdx = rawCommand.indexOf('@');
    if (atIdx === -1) return rawCommand;

    const command = rawCommand.substring(0, atIdx);
    const mentionedBot = rawCommand.substring(atIdx + 1).toLowerCase();
    if (!this._botUsername || mentionedBot === this._botUsername) return command;
    return null;
  }

  // ─── Semantic Dedup ─────────────────────────────────────────────────────

  /**
   * Generate a content-based hash for a signal to detect near-duplicates.
   * Uses normalized text + key metrics rather than raw text prefix matching.
   */
  _contentHash(signal) {
    return contentHash(signal);
  }

  _isSemanticDuplicate(signal) {
    const hash = this._contentHash(signal);
    const lastSeen = this._contentHashes[hash];
    return !!lastSeen && new Date(lastSeen).getTime() > (Date.now() - 4 * 60 * 60 * 1000);
  }

  _recordContentHash(signal) {
    recordContentHash(this._contentHashes, signal);
  }

  _signalKey(signal) {
    return signalKey(signal, 'tg');
  }

  // ─── Rate Limiting ──────────────────────────────────────────────────────

  _checkRateLimit(tier) {
    return checkRateLimit(this._alertHistory, tier);
  }

  _recordAlert(tier) {
    recordAlert(this._alertHistory, tier);
  }

  _isMuted() {
    if (!this._muteUntil) return false;
    if (Date.now() > this._muteUntil) {
      this._muteUntil = null;
      return false;
    }
    return true;
  }

  // ─── Prompt Engineering ─────────────────────────────────────────────────

  _buildEvaluationPrompt() {
    return buildEvaluationPrompt();
  }

  _buildSignalContext(signals, delta) {
    return buildSignalContext(signals, delta);
  }

  // ─── Message Formatting ─────────────────────────────────────────────────

  _formatTieredAlert(evaluation, delta, tier) {
    const tc = TIER_CONFIG[tier];
    const confidenceEmoji = { HIGH: '🟢', MEDIUM: '🟡', LOW: '⚪' }[evaluation.confidence] || '⚪';

    const lines = [
      `${tc.emoji} *CRUCIX ${tc.label}*`,
      ``,
      `*${evaluation.headline}*`,
      ``,
      evaluation.reason,
      ``,
      `Confidence: ${confidenceEmoji} ${evaluation.confidence || 'MEDIUM'}`,
      `Direction: ${delta.summary.direction.toUpperCase()}`,
    ];

    if (evaluation.crossCorrelation) {
      lines.push(`Cross-correlation: ${evaluation.crossCorrelation}`);
    }

    if (evaluation.actionable && evaluation.actionable !== 'Monitor') {
      lines.push(``, `💡 *Action:* ${evaluation.actionable}`);
    }

    if (evaluation.signals?.length) {
      lines.push('', `*Signals:*`);
      for (const sig of evaluation.signals) {
        lines.push(`• ${escapeMd(sig)}`);
      }
    }

    lines.push('', `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`);

    return lines.join('\n');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeMd(text) {
  if (!text) return '';
  // The bot sends alerts with legacy Markdown parse mode, not MarkdownV2.
  // Escape only the characters that legacy Markdown actually treats as markup.
  return text.replace(/([_*`\[])/g, '\\$1');
}
