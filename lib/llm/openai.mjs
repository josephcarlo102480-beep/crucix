// OpenAI Provider — raw fetch, no SDK

import { LLMProvider } from './provider.mjs';

export class OpenAIProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'openai';
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-5.5';
  }

  get isConfigured() { return !!this.apiKey; }

  async complete(systemPrompt, userMessage, opts = {}) {
    const body = {
      model: this.model,
      instructions: systemPrompt,
      input: userMessage,
      max_output_tokens: opts.maxTokens || 4096,
      store: false,
    };

    if (opts.reasoningEffort) {
      body.reasoning = { effort: opts.reasoningEffort };
    }

    if (opts.verbosity) {
      body.text = { verbosity: opts.verbosity };
    }

    if (opts.webSearch) {
      body.tools = [{
        type: 'web_search',
        search_context_size: opts.searchContextSize || 'medium',
      }];
    }

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    if (data.error) {
      const message = data.error.message || JSON.stringify(data.error).substring(0, 200);
      throw new Error(`OpenAI API response error: ${message}`);
    }

    const output = extractOutput(data);
    if (!output.text.trim()) {
      const reason = data.incomplete_details?.reason || data.status || 'no_output_text';
      const outputTypes = (data.output || []).map(item => item.type).join(', ') || 'none';
      throw new Error(`OpenAI returned no final answer (${reason}; output: ${outputTypes}). Try again or reduce the query scope.`);
    }

    return {
      text: output.text,
      citations: output.citations,
      webSearches: output.webSearches,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}

function extractOutput(response) {
  const citations = [];
  const webSearches = [];

  if (typeof response.output_text === 'string') {
    collectResponseMetadata(response, citations, webSearches);
    return { text: response.output_text, citations: dedupeCitations(citations), webSearches };
  }

  const parts = [];
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') {
      webSearches.push({
        query: item.action?.query || item.query || '',
        status: item.status || '',
      });
    }

    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
      for (const annotation of content.annotations || []) {
        const citation = normalizeCitation(annotation);
        if (citation) citations.push(citation);
      }
    }
  }

  return { text: parts.join(''), citations: dedupeCitations(citations), webSearches };
}

function collectResponseMetadata(response, citations, webSearches) {
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') {
      webSearches.push({
        query: item.action?.query || item.query || '',
        status: item.status || '',
      });
    }
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        const citation = normalizeCitation(annotation);
        if (citation) citations.push(citation);
      }
    }
  }
}

function normalizeCitation(annotation) {
  if (annotation?.type !== 'url_citation') return null;
  const citation = annotation.url_citation || annotation;
  if (!citation?.url) return null;
  return {
    url: citation.url,
    title: citation.title || citation.url,
  };
}

function dedupeCitations(citations) {
  const seen = new Set();
  return citations.filter((citation) => {
    if (seen.has(citation.url)) return false;
    seen.add(citation.url);
    return true;
  });
}
