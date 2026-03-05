import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process so emergencyAlert's say/afplay calls don't block tests
vi.mock('child_process', () => ({ execSync: vi.fn() }));

import { LLMClient } from '../../src/llm/client.js';
import type { EnrichedPromptData } from '../../src/llm/prompts.js';

// Fake JWT with chatgpt_account_id
const FAKE_JWT_PAYLOAD = Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc_test123' },
})).toString('base64');
const FAKE_TOKEN = `eyJhbGciOiJSUzI1NiJ9.${FAKE_JWT_PAYLOAD}.fakesig`;

function makePromptData(overrides?: Partial<EnrichedPromptData>): EnrichedPromptData {
  return {
    snapshots: [{
      pair: 'BTCUSDT',
      candles1h: [{ openTime: 1, open: '50000', high: '50500', low: '49500', close: '50200', volume: '100' }],
      candles4h: [{ openTime: 1, open: '49000', high: '50500', low: '48500', close: '50200', volume: '400' }],
      candles15m: [],
      fundingRate: '0.0001',
      fundingHistory: [],
      openInterest: '80000',
      markPrice: '50200',
      longShortRatio: null,
      orderBookBidPct: 50,
      orderBookAskPct: 50,
    }],
    indicators: new Map(),
    portfolio: { balanceUsd: 10, positions: [], sessionPnl: 0 },
    signals: [],
    news: [],
    fearGreed: { value: 50, label: 'Neutral' },
    ...overrides,
  };
}

describe('LLMClient', () => {
  let llm: LLMClient;

  beforeEach(() => {
    llm = new LLMClient(FAKE_TOKEN, 'gpt-5.3-codex');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockSSEResponse(jsonContent: string) {
    const sseText = `data: {"type":"response.output_text.delta","delta":${JSON.stringify(jsonContent)}}\n\ndata: [DONE]\n\n`;
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      body: undefined,
      text: async () => sseText,
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('returns parsed trade decisions', async () => {
    mockSSEResponse(JSON.stringify({
      decisions: [{
        pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
        stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'bullish momentum',
      }],
    }));

    const decisions = await llm.analyze(makePromptData());
    expect(decisions).toHaveLength(1);
    expect(decisions[0].pair).toBe('BTCUSDT');
    expect(decisions[0].action).toBe('LONG');
    expect(decisions[0].leverage).toBe(5);
  });

  it('handles HOLD decisions', async () => {
    mockSSEResponse(JSON.stringify({
      decisions: [{ pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'sideways' }],
    }));

    const decisions = await llm.analyze(makePromptData());
    expect(decisions[0].action).toBe('HOLD');
  });

  it('sends request to Codex backend API', async () => {
    const mock = mockSSEResponse('{"decisions":[]}');

    await llm.analyze(makePromptData());

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, opts] = mock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');

    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-5.3-codex');
    expect(body.instructions).toBeDefined();
    expect(body.input).toBeInstanceOf(Array);
    expect(body.input[0].content).toContain('BTCUSDT');
  });

  it('returns empty decisions on parse error', async () => {
    mockSSEResponse('not json');

    const decisions = await llm.analyze(makePromptData());
    expect(decisions).toHaveLength(0);
  });

  it('parses JSON even with explanation text around it', async () => {
    const jsonWithExplanation = `Here's my analysis of the market conditions.

{"decisions":[{"pair":"BTCUSDT","action":"HOLD","size_pct":0,"leverage":0,"stop_loss_pct":0,"take_profit_pct":0,"reasoning":"test","confidence":75}]}

I hope this helps.`;

    mockSSEResponse(jsonWithExplanation);
    const data = makePromptData();
    const result = await llm.analyze(data);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('HOLD');
  });

  it('handles confidence field in decisions', async () => {
    const json = JSON.stringify({
      decisions: [{ pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'strong', confidence: 85 }],
    });
    mockSSEResponse(json);
    const result = await llm.analyze(makePromptData());
    expect(result[0].confidence).toBe(85);
  });

  it('throws on API error so TradingLoop can switch layers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
      body: undefined,
    }));

    await expect(llm.analyze(makePromptData())).rejects.toThrow('401');
  });
});
