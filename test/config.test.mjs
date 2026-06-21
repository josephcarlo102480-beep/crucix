import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configUrl = pathToFileURL(join(__dirname, '..', 'crucix.config.mjs')).href;

async function loadConfigWithEnv(overrides) {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value == null) delete process.env[key];
      else process.env[key] = String(value);
    }

    return (await import(`${configUrl}?t=${Date.now()}-${Math.random()}`)).default;
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('crucix.config', () => {
  it('uses valid integer env overrides', async () => {
    const config = await loadConfigWithEnv({
      PORT: '4123',
      REFRESH_INTERVAL_MINUTES: '30',
      TELEGRAM_POLL_INTERVAL: '750',
    });

    assert.equal(config.port, 4123);
    assert.equal(config.refreshIntervalMinutes, 30);
    assert.equal(config.telegram.botPollingInterval, 750);
  });

  it('falls back on invalid integer env values', async () => {
    const config = await loadConfigWithEnv({
      PORT: '-1',
      REFRESH_INTERVAL_MINUTES: '0',
      TELEGRAM_POLL_INTERVAL: 'oops',
    });

    assert.equal(config.port, 3117);
    assert.equal(config.refreshIntervalMinutes, 15);
    assert.equal(config.telegram.botPollingInterval, 5000);
  });

  it('uses OPENAI_API_KEY as an OpenAI LLM fallback', async () => {
    const config = await loadConfigWithEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: null,
      OPENAI_API_KEY: 'sk-openai-test',
    });

    assert.equal(config.llm.apiKey, 'sk-openai-test');
  });
});
