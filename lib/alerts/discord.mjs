// Discord Alerter — Multi-tier alerts + slash commands via discord.js
// Multi-tier alerting with LLM evaluation, rule-based fallback, and semantic dedup

import {
  ALERT_RATE_LIMITS,
  checkRateLimit,
  evaluateAlertDecision,
  getNewSignals,
  recordAlert,
  recordContentHash,
  signalKey,
} from './shared.mjs';
import { formatUtcTime } from '../bot/messages.mjs';

// Discord rejects an embed whose description exceeds this.
const MAX_EMBED_DESCRIPTION = 4096;
// Give up on the gateway handshake rather than leaving start() pending forever.
const READY_TIMEOUT_MS = 30_000;

// ─── Alert Tiers ───────────────────────────────────────────────────────────

const TIER_CONFIG = {
  FLASH: { ...ALERT_RATE_LIMITS.FLASH, color: 0xFF0000, label: 'FLASH' },
  PRIORITY: { ...ALERT_RATE_LIMITS.PRIORITY, color: 0xFFAA00, label: 'PRIORITY' },
  ROUTINE: { ...ALERT_RATE_LIMITS.ROUTINE, color: 0x3498DB, label: 'ROUTINE' },
};

// Slash command definitions for Discord's API
const SLASH_COMMANDS = [
  { name: 'status',    description: 'System health, last sweep time, source status' },
  { name: 'sweep',     description: 'Trigger a manual sweep cycle' },
  { name: 'brief',     description: 'Compact intelligence summary' },
  { name: 'portfolio', description: 'Portfolio status (if Alpaca connected)' },
  { name: 'alerts',    description: 'Recent alert history' },
  { name: 'mute',      description: 'Mute alerts (default 1h)',
    options: [{ name: 'hours', description: 'Hours to mute (default: 1)', type: 10, required: false }] },
  { name: 'unmute',    description: 'Resume alerts' },
];

export class DiscordAlerter {
  constructor({ botToken, channelId, guildId, webhookUrl }) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.guildId = guildId;        // Server ID for slash command registration
    this.webhookUrl = webhookUrl;  // Fallback: webhook-only mode (no bot needed)
    this._client = null;
    this._alertHistory = [];
    this._contentHashes = {};
    this._muteUntil = null;
    this._commandHandlers = {};
    this._ready = false;
    this._evaluation = null;      // in-flight evaluateAndAlert, if any
    this._skipLogged = false;
  }

  get isConfigured() {
    return this.hasBotConfigured || this.hasWebhookConfigured;
  }

  get hasBotConfigured() {
    return !!(this.botToken && this.channelId);
  }

  get hasWebhookConfigured() {
    return !!this.webhookUrl;
  }

  // ─── Bot Lifecycle ──────────────────────────────────────────────────────

  /**
   * Start the Discord bot. Connects to the gateway, registers slash commands,
   * and begins listening for interactions.
   */
  async start() {
    if (!this.hasBotConfigured) {
      if (this.hasWebhookConfigured) {
        console.log('[Discord] Webhook-only mode enabled');
      }
      return;
    }

    try {
      // Dynamic import — discord.js is optional, only loaded if configured
      const { Client, Events, GatewayIntentBits, REST, Routes, EmbedBuilder, SlashCommandBuilder } = await import('discord.js');
      this._EmbedBuilder = EmbedBuilder;
      this._Events = Events;

      this._client = new Client({
        intents: [GatewayIntentBits.Guilds],
      });

      // Handle slash command interactions. Anything thrown in here would
      // otherwise surface as an unhandled rejection and take the process down.
      this._client.on(Events.InteractionCreate ?? 'interactionCreate', async (interaction) => {
        try {
          if (!interaction.isChatInputCommand()) return;
          await this._handleCommand(interaction);
        } catch (err) {
          console.error('[Discord] Interaction handler error:', err?.message || err);
          try {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'Command failed.' });
            }
          } catch (replyErr) {
            console.error('[Discord] Could not report interaction failure:', replyErr?.message || replyErr);
          }
        }
      });

      // Connect
      await this._client.login(this.botToken);
      await this._waitForReady();

      // Register slash commands after login so the application/client IDs are available.
      await this._registerCommands(REST, Routes, SlashCommandBuilder);

    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        console.warn('[Discord] discord.js not installed. Run: npm install discord.js');
        console.warn('[Discord] Falling back to webhook-only mode (if DISCORD_WEBHOOK_URL is set).');
      } else {
        console.error('[Discord] Failed to start bot:', err.message);
      }
    }
  }

  /**
   * Stop the bot gracefully.
   */
  async stop() {
    if (this._client) {
      this._client.destroy();
      this._client = null;
      this._ready = false;
      console.log('[Discord] Bot disconnected');
    }
  }

  async _waitForReady() {
    if (!this._client) return;
    if (this._client.isReady?.()) {
      this._ready = true;
      console.log(`[Discord] Bot online as ${this._client.user.tag}`);
      return;
    }

    // Events.ClientReady, not the deprecated 'ready' string — and never wait
    // on it forever: a gateway that never finishes the handshake would
    // otherwise leave start() (and the boot sequence behind it) pending.
    const readyEvent = this._Events?.ClientReady ?? 'clientReady';
    await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._client?.off?.(readyEvent, onReady);
        if (ok) {
          this._ready = true;
          console.log(`[Discord] Bot online as ${this._client?.user?.tag ?? 'unknown'}`);
        } else {
          console.warn(`[Discord] Gateway not ready after ${READY_TIMEOUT_MS / 1000}s — continuing without the bot`);
        }
        resolve();
      };
      const onReady = () => finish(true);
      const timer = setTimeout(() => finish(false), READY_TIMEOUT_MS);
      timer.unref?.();
      this._client.once(readyEvent, onReady);
    });
  }

  // ─── Slash Command Registration ─────────────────────────────────────────

  async _registerCommands(REST, Routes, SlashCommandBuilder) {
    const rest = new REST({ version: '10' }).setToken(this.botToken);
    const applicationId = this._client?.application?.id ?? this._client?.user?.id;

    if (!applicationId) {
      console.warn('[Discord] Skipping slash command registration: application ID unavailable');
      return;
    }

    const commands = SLASH_COMMANDS.map(cmd => {
      const builder = new SlashCommandBuilder()
        .setName(cmd.name)
        .setDescription(cmd.description);

      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.type === 10) { // NUMBER
            builder.addNumberOption(o =>
              o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
            );
          }
        }
      }
      return builder.toJSON();
    });

    try {
      if (this.guildId) {
        // Guild commands (instant, for development)
        await rest.put(Routes.applicationGuildCommands(applicationId, this.guildId), { body: commands });
        console.log(`[Discord] Registered ${commands.length} guild slash commands`);
      } else {
        // Global commands (can take up to 1h to propagate)
        await rest.put(Routes.applicationCommands(applicationId), { body: commands });
        console.log(`[Discord] Registered ${commands.length} global slash commands`);
      }
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err.message);
    }
  }

  // ─── Command Handling ───────────────────────────────────────────────────

  /**
   * Register a command handler.
   * @param {string} name - command name (without /)
   * @param {Function} handler - async (args) => responseText
   */
  onCommand(name, handler) {
    this._commandHandlers[name.toLowerCase()] = handler;
  }

  async _handleCommand(interaction) {
    const name = interaction.commandName;

    // Built-in commands
    if (name === 'mute') {
      const hours = interaction.options.getNumber('hours') || 1;
      this._muteUntil = Date.now() + hours * 60 * 60 * 1000;
      await interaction.reply({
        embeds: [this._embed('Alerts Muted', `Alerts silenced for ${hours}h — until ${formatUtcTime(this._muteUntil)}.\nUse \`/unmute\` to resume.`, 0x95A5A6)],
        ephemeral: true,
      });
      return;
    }

    if (name === 'unmute') {
      this._muteUntil = null;
      await interaction.reply({
        embeds: [this._embed('Alerts Resumed', 'You will receive the next signal evaluation.', 0x2ECC71)],
        ephemeral: true,
      });
      return;
    }

    if (name === 'alerts') {
      const recent = this._alertHistory.slice(-10);
      if (recent.length === 0) {
        await interaction.reply({ content: 'No recent alerts.', ephemeral: true });
        return;
      }
      const tierEmoji = { FLASH: '🔴', PRIORITY: '🟡', ROUTINE: '🔵' };
      const lines = recent.map(a =>
        `${tierEmoji[a.tier] || '⚪'} **${a.tier}** — ${formatUtcTime(a.timestamp)}`
      );
      await interaction.reply({
        embeds: [this._embed(`Recent Alerts (${recent.length})`, lines.join('\n'), 0x3498DB)],
        ephemeral: true,
      });
      return;
    }

    // Delegate to registered handlers
    const handler = this._commandHandlers[name];
    if (handler) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const response = await handler();
        if (response) {
          // If response is long, send as embed; otherwise plain text
          if (response.length > 200) {
            await interaction.editReply({ embeds: [this._embed('Crucix', response, 0x00E5FF)] });
          } else {
            await interaction.editReply({ content: response });
          }
        } else {
          await interaction.editReply({ content: 'Done.' });
        }
      } catch (err) {
        console.error(`[Discord] Command /${name} error:`, err.message);
        await interaction.editReply({ content: `Command failed: ${err.message}` });
      }
    } else {
      await interaction.reply({ content: `Unknown command: /${name}`, ephemeral: true });
    }
  }

  // ─── Sending Messages ───────────────────────────────────────────────────

  /**
   * Send a message to the configured channel.
   * Works with the bot client or falls back to webhook URL.
   */
  async sendMessage(content, embeds = []) {
    if (!this.isConfigured) return false;

    // Try bot client first
    if (this.hasBotConfigured && this._ready && this._client) {
      try {
        const channel = await this._client.channels.fetch(this.channelId);
        if (channel) {
          await channel.send({ content: content || undefined, embeds });
          return true;
        }
      } catch (err) {
        console.error('[Discord] Send via bot failed:', err.message);
      }
    }

    // Fallback: webhook URL
    if (this.hasWebhookConfigured) {
      return this._sendWebhook(this.webhookUrl, content, embeds);
    }

    console.warn('[Discord] Cannot send — bot not ready and no webhook URL configured');
    return false;
  }

  async _sendWebhook(url, content, embeds) {
    try {
      const body = {};
      if (content) body.content = content;
      if (embeds?.length > 0) {
        body.embeds = embeds.map(e => e.toJSON ? e.toJSON() : e);
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.error(`[Discord] Webhook failed (${res.status}): ${err.substring(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Discord] Webhook error:', err.message);
      return false;
    }
  }

  // Backward-compatible alias
  async sendAlert(message) {
    return this.sendMessage(message);
  }

  // ─── Multi-Tier Alert Evaluation ────────────────────────────────────────
  // Shared eval pipeline (lib/alerts/shared.mjs)

  /**
   * Evaluate a delta and, if it clears the bar, post an alert.
   *
   * server.mjs calls this fire-and-forget, so two sweeps can overlap. Both
   * would read the same not-yet-marked signals and alert on them twice, so a
   * second evaluation arriving while one is running is dropped.
   */
  async evaluateAndAlert(llmProvider, delta, memory) {
    if (this._evaluation) {
      if (!this._skipLogged) {
        console.warn('[Discord] Evaluation already in flight — skipping this one to avoid double alerts');
        this._skipLogged = true;
      }
      return false;
    }

    this._evaluation = this._evaluateAndAlert(llmProvider, delta, memory);
    try {
      return await this._evaluation;
    } finally {
      this._evaluation = null;
      this._skipLogged = false;
    }
  }

  async _evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;
    if (this._isMuted()) {
      console.log('[Discord] Alerts muted until', formatUtcTime(this._muteUntil));
      return false;
    }

    const newSignals = getNewSignals(delta, memory, this._contentHashes, 'dc');

    if (newSignals.length === 0) return false;

    const evaluation = await evaluateAlertDecision({
      llmProvider,
      signals: newSignals,
      delta,
      logLabel: 'Discord',
    });

    if (!evaluation?.shouldAlert) {
      console.log('[Discord] No alert —', evaluation?.reason || 'no qualifying signals');
      return false;
    }

    const tier = TIER_CONFIG[evaluation.tier] ? evaluation.tier : 'ROUTINE';
    if (!this._checkRateLimit(tier)) {
      console.log(`[Discord] Rate limited for tier ${tier}`);
      return false;
    }

    // Build Discord embed
    const embed = this._buildAlertEmbed(evaluation, delta, tier);
    const sent = await this.sendMessage(null, [embed]);

    if (sent) {
      const now = new Date().toISOString();
      const keys = newSignals.map(s => this._signalKey(s));
      for (const s of newSignals) this._recordContentHash(s);
      // One write for the whole batch instead of one per signal.
      if (typeof memory.markManyAsAlerted === 'function') {
        memory.markManyAsAlerted(keys, now);
      } else {
        for (const key of keys) memory.markAsAlerted(key, now);
      }
      this._recordAlert(tier);
      console.log(`[Discord] ${tier} alert sent (${evaluation._source || 'llm'}): ${evaluation.headline}`);
    }

    return sent;
  }

  // ─── Discord-Native Rich Embed Formatting ───────────────────────────────

  _buildAlertEmbed(evaluation, delta, tier) {
    const tc = TIER_CONFIG[tier];
    const tierEmoji = { FLASH: '🔴', PRIORITY: '🟡', ROUTINE: '🔵' }[tier] || '⚪';
    const confidenceEmoji = { HIGH: '🟢', MEDIUM: '🟡', LOW: '⚪' }[evaluation.confidence] || '⚪';

    const embed = this._embed(
      `${tierEmoji} CRUCIX ${tc.label}`,
      `**${evaluation.headline}**\n\n${evaluation.reason}`,
      tc.color
    );

    // Add fields
    const fields = [
      { name: 'Direction', value: delta.summary.direction.toUpperCase(), inline: true },
      { name: 'Confidence', value: `${confidenceEmoji} ${evaluation.confidence || 'MEDIUM'}`, inline: true },
    ];

    if (evaluation.crossCorrelation) {
      fields.push({ name: 'Cross-Correlation', value: evaluation.crossCorrelation, inline: true });
    }

    if (evaluation.actionable && evaluation.actionable !== 'Monitor') {
      fields.push({ name: '💡 Action', value: evaluation.actionable, inline: false });
    }

    if (evaluation.signals?.length) {
      fields.push({ name: 'Signals', value: evaluation.signals.join(' · '), inline: false });
    }

    // discord.js EmbedBuilder style
    if (embed.setFields) {
      embed.setFields(fields);
      embed.setFooter({ text: `Crucix Intelligence · ${formatUtcTime(Date.now())}` });
    } else {
      // Raw embed object for webhook fallback
      embed.fields = fields;
      embed.footer = { text: `Crucix Intelligence · ${formatUtcTime(Date.now())}` };
    }

    return embed;
  }

  /**
   * Create a simple embed. Returns EmbedBuilder if available, otherwise raw object.
   */
  _embed(title, description, color) {
    // Discord rejects the whole message if the description is over the limit,
    // so trim before building rather than losing the alert entirely.
    const text = truncateForEmbed(description);
    if (this._EmbedBuilder) {
      return new this._EmbedBuilder()
        .setTitle(title)
        .setDescription(text)
        .setColor(color)
        .setTimestamp();
    }
    // Raw embed for webhook mode (no discord.js loaded)
    return {
      title,
      description: text,
      color,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Semantic Dedup ────────────────────────────────────────────────────

  _recordContentHash(signal) {
    recordContentHash(this._contentHashes, signal);
  }

  _signalKey(signal) {
    return signalKey(signal, 'dc');
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
    if (Date.now() > this._muteUntil) { this._muteUntil = null; return false; }
    return true;
  }
}

function truncateForEmbed(description) {
  if (typeof description !== 'string') return description;
  if (description.length <= MAX_EMBED_DESCRIPTION) return description;
  return `${description.slice(0, MAX_EMBED_DESCRIPTION - 1)}\u2026`;
}
