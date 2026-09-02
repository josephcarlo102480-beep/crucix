// Yahoo Finance — Live market quotes (no API key required)
// Provides real-time prices for stocks, ETFs, crypto, commodities
// Replaces the need for Alpaca or any paid market data provider

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Symbols to track — covers broad market, rates, commodities, crypto, volatility
const SYMBOLS = {
  // Indexes / ETFs
  SPY: 'S&P 500',
  QQQ: 'Nasdaq 100',
  DIA: 'Dow Jones',
  IWM: 'Russell 2000',
  // Rates / Credit
  TLT: '20Y+ Treasury',
  HYG: 'High Yield Corp',
  LQD: 'IG Corporate',
  // Commodities
  'GC=F': 'Gold',
  'SI=F': 'Silver',
  'CL=F': 'WTI Crude',
  'BZ=F': 'Brent Crude',
  'NG=F': 'Natural Gas',
  // Crypto
  'BTC-USD': 'Bitcoin',
  'ETH-USD': 'Ethereum',
  // Volatility
  '^VIX': 'VIX',
};

function quoteError(symbol, message) {
  return { symbol, name: SYMBOLS[symbol] || symbol, error: message };
}

async function fetchQuote(symbol, opts = {}) {
  try {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
    const data = await safeFetch(url, {
      timeout: 8000,
      signal: opts.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!data || data.error) {
      return quoteError(symbol, data?.error || 'no response from Yahoo Finance');
    }
    if (data.rawText !== undefined) {
      return quoteError(symbol, `non-JSON body: ${String(data.rawText).slice(0, 100)}`);
    }
    const result = data.chart?.result?.[0];
    if (!result) {
      return quoteError(symbol, data.chart?.error?.description || 'Yahoo Finance returned no chart result');
    }

    const meta = result.meta || {};
    const quotes = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const timestamps = result.timestamp || [];

    // Get current price and previous close
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2];
    const change = price && prevClose ? price - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    // Build 5-day history
    const history = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) {
        history.push({
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          close: Math.round(closes[i] * 100) / 100,
        });
      }
    }

    if (!Number.isFinite(price)) {
      return quoteError(symbol, 'Yahoo Finance returned no price for this symbol');
    }

    return {
      symbol,
      name: SYMBOLS[symbol] || meta.shortName || symbol,
      price: Math.round(price * 100) / 100,
      prevClose: Math.round((prevClose || 0) * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      marketState: meta.marketState || 'UNKNOWN',
      history,
    };
  } catch (e) {
    return quoteError(symbol, e.message);
  }
}

export async function briefing(opts = {}) {
  return collect(opts);
}

export async function collect(opts = {}) {
  const { signal } = opts || {};
  const symbols = Object.keys(SYMBOLS);
  const results = await Promise.allSettled(
    symbols.map(s => fetchQuote(s, { signal }))
  );

  const quotes = {};
  const failures = [];
  let ok = 0;

  // Every failure is filed under its own symbol. The old code collapsed
  // rejections into a single `quotes.unknown` entry, so a broken symbol both
  // vanished from its group and overwrote the previous broken symbol.
  results.forEach((r, i) => {
    const symbol = symbols[i];
    const q = r.status === 'fulfilled'
      ? (r.value || quoteError(symbol, 'fetch returned nothing'))
      : quoteError(symbol, r.reason?.message || 'fetch failed');
    quotes[symbol] = q;
    if (q.error) failures.push({ symbol, error: q.error });
    else ok++;
  });

  // Categorize for easy dashboard consumption
  return {
    source: 'YFinance',
    timestamp: new Date().toISOString(),
    quotes,
    summary: {
      totalSymbols: symbols.length,
      ok,
      failed: failures.length,
      timestamp: new Date().toISOString(),
    },
    indexes: pickGroup(quotes, ['SPY', 'QQQ', 'DIA', 'IWM']),
    rates: pickGroup(quotes, ['TLT', 'HYG', 'LQD']),
    commodities: pickGroup(quotes, ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'NG=F']),
    crypto: pickGroup(quotes, ['BTC-USD', 'ETH-USD']),
    volatility: pickGroup(quotes, ['^VIX']),
    ...(failures.length ? {
      error: failures.length === symbols.length
        ? `Yahoo Finance returned no usable quotes: ${failures[0].error}`
        : `Yahoo Finance failed for ${failures.length}/${symbols.length} symbols: ${failures.map(f => f.symbol).join(', ')}`,
      failures,
    } : {}),
  };
}

// Only quotes that actually carry a price belong in a group — an errored entry
// rendered as a tile with `undefined` price.
function pickGroup(quotes, symbols) {
  return symbols.map(s => quotes[s]).filter(q => q && !q.error);
}
