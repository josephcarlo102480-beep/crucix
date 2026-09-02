// Mistral AI Provider — raw fetch, no SDK
// Uses Mistral's OpenAI-compatible Chat Completions API

import { OpenAICompatibleProvider } from './openaiCompatible.mjs';

export class MistralProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super(config, {
      name: 'mistral',
      label: 'Mistral',
      endpoint: 'https://api.mistral.ai/v1/chat/completions',
      defaultModel: 'mistral-large-latest',
    });
  }
}
