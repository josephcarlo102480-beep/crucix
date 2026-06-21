// OpenAI provider — unit tests
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../lib/llm/openai.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';

describe('OpenAIProvider', () => {
  it('should set defaults correctly', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    assert.equal(provider.name, 'openai');
    assert.equal(provider.model, 'gpt-5.5');
    assert.equal(provider.isConfigured, true);
  });

  it('should accept custom model', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-5.5-mini' });
    assert.equal(provider.model, 'gpt-5.5-mini');
  });

  it('should report not configured without API key', () => {
    const provider = new OpenAIProvider({});
    assert.equal(provider.isConfigured, false);
  });

  it('should throw on API error', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') })
    );
    try {
      await assert.rejects(
        () => provider.complete('system', 'user'),
        (err) => {
          assert.match(err.message, /OpenAI API 401/);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should parse successful Responses API output', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const mockResponse = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Hello from OpenAI' },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'gpt-5.5-2026-06-10',
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(mockResponse) })
    );
    try {
      const result = await provider.complete('You are helpful.', 'Say hello');
      assert.equal(result.text, 'Hello from OpenAI');
      assert.deepEqual(result.citations, []);
      assert.deepEqual(result.webSearches, []);
      assert.equal(result.usage.inputTokens, 10);
      assert.equal(result.usage.outputTokens, 5);
      assert.equal(result.model, 'gpt-5.5-2026-06-10');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should send correct Responses API request format', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test-key', model: 'gpt-5.5' });
    let capturedUrl, capturedOpts;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn((url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'gpt-5.5',
        }),
      });
    });
    try {
      await provider.complete('system prompt', 'user message', {
        maxTokens: 2048,
        reasoningEffort: 'low',
        verbosity: 'low',
      });
      assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
      assert.equal(capturedOpts.method, 'POST');
      const headers = capturedOpts.headers;
      assert.equal(headers['Content-Type'], 'application/json');
      assert.equal(headers['Authorization'], 'Bearer sk-test-key');
      const body = JSON.parse(capturedOpts.body);
      assert.equal(body.model, 'gpt-5.5');
      assert.equal(body.instructions, 'system prompt');
      assert.equal(body.input, 'user message');
      assert.equal(body.max_output_tokens, 2048);
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.deepEqual(body.text, { verbosity: 'low' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should enable web search and return citations', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test-key', model: 'gpt-5.5' });
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          output: [
            {
              type: 'web_search_call',
              status: 'completed',
              action: { query: 'latest oil prices' },
            },
            {
              type: 'message',
              content: [{
                type: 'output_text',
                text: 'WTI moved higher today.',
                annotations: [{
                  type: 'url_citation',
                  url: 'https://example.com/oil',
                  title: 'Oil market update',
                }],
              }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 8 },
          model: 'gpt-5.5',
        }),
      });
    });
    try {
      const result = await provider.complete('system', 'user', {
        webSearch: true,
        searchContextSize: 'low',
      });

      assert.deepEqual(capturedBody.tools, [{ type: 'web_search', search_context_size: 'low' }]);
      assert.equal(result.text, 'WTI moved higher today.');
      assert.deepEqual(result.citations, [{ url: 'https://example.com/oil', title: 'Oil market update' }]);
      assert.deepEqual(result.webSearches, [{ query: 'latest oil prices', status: 'completed' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw when OpenAI returns no final text', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'web_search_call', status: 'completed' }],
          usage: {},
        }),
      })
    );
    try {
      await assert.rejects(
        () => provider.complete('sys', 'user'),
        /OpenAI returned no final answer \(max_output_tokens; output: web_search_call\)/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('createLLMProvider — openai', () => {
  it('should create OpenAIProvider for provider=openai', () => {
    const provider = createLLMProvider({ provider: 'openai', apiKey: 'sk-test', model: null });
    assert.ok(provider instanceof OpenAIProvider);
    assert.equal(provider.name, 'openai');
    assert.equal(provider.isConfigured, true);
  });

  it('should be case-insensitive', () => {
    const provider = createLLMProvider({ provider: 'OpenAI', apiKey: 'sk-test', model: null });
    assert.ok(provider instanceof OpenAIProvider);
  });
});
