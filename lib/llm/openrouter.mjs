// OpenRouter Provider — raw fetch, no SDK

import { OpenAICompatibleProvider } from './openaiCompatible.mjs';

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super(config, {
      name: 'openrouter',
      label: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      defaultModel: 'openrouter/auto',
      headers: {
        'HTTP-Referer': 'https://github.com/calesthio/Crucix',
        'X-Title': 'Crucix',
      },
    });
  }
}
