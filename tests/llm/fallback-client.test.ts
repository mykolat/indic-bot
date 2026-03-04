import { describe, it, expect, vi, afterEach } from 'vitest';
import { FallbackLLMClient } from '../../src/llm/fallback-client.js';
import type { Position } from '../../src/risk/manager.js';

const POSITIONS: Position[] = [
  { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -1.5, heldHours: 3.5 },
];

afterEach(() => vi.unstubAllGlobals());

function mockFetch(responseJson: object) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => responseJson,
  }));
}

function mockFetchFail(status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Error',
  }));
}

describe('FallbackLLMClient', () => {
  it('returns HOLD decision when LLM responds HOLD', async () => {
    mockFetch({
      choices: [{ message: { content: '{"decisions":[{"pair":"BTCUSDT","action":"HOLD","confidence":70,"reasoning":"SL protects"}]}' } }],
    });

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, -1.5);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('HOLD');
    expect(decisions[0].pair).toBe('BTCUSDT');
  });

  it('returns CLOSE decision', async () => {
    mockFetch({
      choices: [{ message: { content: '{"decisions":[{"pair":"BTCUSDT","action":"CLOSE","confidence":80,"reasoning":"exit now"}]}' } }],
    });

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, -3);

    expect(decisions[0].action).toBe('CLOSE');
  });

  it('filters out LONG and SHORT even if LLM returns them', async () => {
    mockFetch({
      choices: [{ message: { content: '{"decisions":[{"pair":"BTCUSDT","action":"LONG","confidence":75,"reasoning":"bullish"},{"pair":"ETHUSDT","action":"CLOSE","confidence":80,"reasoning":"exit"}]}' } }],
    });

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, 0);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('CLOSE');
  });

  it('returns [] when no positions', async () => {
    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze([], 0);

    expect(decisions).toHaveLength(0);
  });

  it('returns [] on API error (does not throw)', async () => {
    mockFetchFail(429);

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini', false);
    const decisions = await client.analyze(POSITIONS, -2);

    expect(decisions).toHaveLength(0);
  });

  it('throws on API error so TradingLoop can detect fallback exhaustion', async () => {
    mockFetchFail(429);

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini', true);
    await expect(client.analyze(POSITIONS, -2)).rejects.toThrow('429');
  });

  it('includes soul External Insights in prompt when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"decisions":[]}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const soulContent = `# Soul\n## External Insights\n- [2026-03-04] audit: Close ETH immediately\n## Other\nstuff`;
    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    await client.analyze(POSITIONS, -3, soulContent);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('Close ETH immediately');
  });

  it('sends request to standard OpenAI API endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"decisions":[]}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    await client.analyze(POSITIONS, 0);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBeLessThanOrEqual(500);
  });
});
