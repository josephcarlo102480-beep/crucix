// Ollama Provider — raw fetch, no SDK
// Uses Ollama's OpenAI-compatible Chat Completions API
// No API key required — fully local inference

import { OpenAICompatibleProvider } from './openaiCompatible.mjs';

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super(config, {
      name: 'ollama',
      label: 'Ollama',
      defaultModel: 'llama3.1:8b',
      // Local inference on a Pi-class box is slow; give it twice the cloud budget.
      defaultTimeout: 120000,
    });
    this.baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  }

  get endpoint() { return `${this.baseUrl}/v1/chat/completions`; }

  // Local inference needs no key — a configured model is enough.
  get isConfigured() { return !!this.model; }
}
