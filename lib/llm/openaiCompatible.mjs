// Shared base for providers that speak the OpenAI Chat Completions dialect.
//
// MiniMax, Mistral, OpenRouter and Ollama differ only in endpoint, headers,
// default model and default timeout — everything else (request shape, error
// text, response unwrapping) was copied four times. Each provider is now a
// thin subclass supplying that spec.

import { LLMProvider } from './provider.mjs';

export class OpenAICompatibleProvider extends LLMProvider {
  /**
   * @param {object} config  user config: { apiKey, model, ... }
   * @param {object} spec
   * @param {string} spec.name            provider id (`this.name`)
   * @param {string} spec.label           human label used in error messages
   * @param {string} [spec.endpoint]      chat completions URL (or override `endpoint`)
   * @param {string} spec.defaultModel
   * @param {number} [spec.defaultTimeout=60000]
   * @param {object} [spec.headers]       extra headers merged over the defaults
   */
  constructor(config = {}, spec = {}) {
    super(config);
    this.name = spec.name;
    this.apiKey = config.apiKey;
    this.model = config.model || spec.defaultModel;
    this._spec = spec;
  }

  /** Chat completions URL. Overridden where the host is configurable. */
  get endpoint() {
    return this._spec.endpoint;
  }

  get isConfigured() { return !!this.apiKey; }

  /** Bearer auth is omitted entirely when there is no key (local Ollama). */
  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return { ...headers, ...(this._spec.headers || {}) };
  }

  buildBody(systemPrompt, userMessage, opts) {
    return {
      model: this.model,
      max_tokens: opts.maxTokens || 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    };
  }

  async complete(systemPrompt, userMessage, opts = {}) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(systemPrompt, userMessage, opts)),
      signal: AbortSignal.timeout(opts.timeout || this._spec.defaultTimeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`${this._spec.label} API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}
