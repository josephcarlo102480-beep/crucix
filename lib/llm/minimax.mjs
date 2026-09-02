// MiniMax Provider — raw fetch, no SDK
// Uses MiniMax's OpenAI-compatible Chat Completions API

import { OpenAICompatibleProvider } from './openaiCompatible.mjs';

export class MiniMaxProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super(config, {
      name: 'minimax',
      label: 'MiniMax',
      endpoint: 'https://api.minimax.io/v1/chat/completions',
      defaultModel: 'MiniMax-M2.5',
    });
  }
}
