import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMClient } from '../../src/llm/client.js';
import type { MarketSnapshot } from '../../src/binance/market-data.js';
import type { TradingViewSignal } from '../../src/webhook/signal-buffer.js';
import type { PortfolioState } from '../../src/risk/manager.js';

// Fake JWT with chatgpt_account_id
const FAKE_JWT_PAYLOAD = Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc_test123' },
})).toString('base64');
const FAKE_TOKEN = `eyJhbGciOiJSUzI1NiJ9.${FAKE_JWT_PAYLOAD}.fakesig`;

describe('LLMClient', () => {
  let llm: LLMClient;
  let originalFetch: typeof globalThis.fetch;

  const fakeSnapshot: MarketSnapshot = {
    pair: 'BTCUSDT',
    candles1h: [{ openTime: 1, open: '50000', high: '50500', low: '49500', close: '50200', volume: '100' }],
    candles4h: [{ openTime: 1, open: '49000', high: '50500', low: '48500', close: '50200', volume: '400' }],
    fundingRate: '0.0001',
    openInterest: '80000',
    markPrice: '50200',
  };

  const fakePortfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    llm = new LLMClient(FAKE_TOKEN, 'gpt-5.3-chat-latest');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponse(output_text: string) {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text }),
    });
    globalThis.fetch = mock as any;
    return mock;
  }

  it('returns parsed trade decisions', async () => {
    mockFetchResponse(JSON.stringify({
      decisions: [{
        pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
        stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'bullish momentum',
      }],
    }));

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].pair).toBe('BTCUSDT');
    expect(decisions[0].action).toBe('LONG');
    expect(decisions[0].leverage).toBe(5);
  });

  it('handles HOLD decisions', async () => {
    mockFetchResponse(JSON.stringify({
      decisions: [{ pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'sideways' }],
    }));

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions[0].action).toBe('HOLD');
  });

  it('sends request to Codex backend API with correct structure', async () => {
    const mock = mockFetchResponse('{"decisions":[]}');

    await llm.analyze([fakeSnapshot], fakePortfolio, []);

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, opts] = mock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');

    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-5.3-chat-latest');
    expect(body.instructions).toBeDefined();
    expect(body.input).toContain('BTCUSDT');
  });

  it('returns empty decisions on parse error', async () => {
    mockFetchResponse('not json');

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions).toHaveLength(0);
  });
});
