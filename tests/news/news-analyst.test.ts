import { describe, it, expect, vi } from 'vitest';
import { NewsAnalystAgent } from '../../src/news/news-analyst.js';
import type { CryptoNews } from '../../src/news/types.js';

const mockNews: CryptoNews[] = [
  { title: 'Bitcoin ETF sees record $8B inflows', date: '2026-03-04', coins: ['BTC'], sentiment: 5, source: 'Bloomberg' },
  { title: 'Fed signals rate hold in March', date: '2026-03-04', coins: [], sentiment: -1, source: 'Reuters' },
];

describe('NewsAnalystAgent', () => {
  it('returns structured NewsAnalysis from LLM response', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        market_summary: 'BTC bullish on ETF flows',
        top_signals: [
          {
            coins: ['BTC'], direction: 'bullish', importance: 9,
            timeframe: 'short', catalyst: 'ETF inflows', reasoning: 'Demand surge',
            price_impact: 'high', expires_hours: 48, source_count: 3, conflicting: false,
          },
        ],
        overall_sentiment: 'bullish',
        macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'btc_gaining' },
        risk_events: ['FOMC tomorrow'],
      })),
    };

    const agent = new NewsAnalystAgent(mockLlm as any);
    const result = await agent.analyze(mockNews);

    expect(mockLlm.call).toHaveBeenCalledTimes(1);
    expect(result.market_summary).toBe('BTC bullish on ETF flows');
    expect(result.top_signals).toHaveLength(1);
    expect(result.top_signals[0].importance).toBe(9);
    expect(result.overall_sentiment).toBe('bullish');
    expect(result.macro_signals.fed_stance).toBe('neutral');
    expect(result.risk_events).toContain('FOMC tomorrow');
  });

  it('returns fallback on LLM parse error', async () => {
    const mockLlm = { call: vi.fn().mockResolvedValue('not valid json') };
    const agent = new NewsAnalystAgent(mockLlm as any);
    const result = await agent.analyze(mockNews);

    expect(result.market_summary).toContain('unavailable');
    expect(result.top_signals).toHaveLength(0);
  });

  it('returns fallback on LLM call failure', async () => {
    const mockLlm = { call: vi.fn().mockRejectedValue(new Error('API down')) };
    const agent = new NewsAnalystAgent(mockLlm as any);
    const result = await agent.analyze(mockNews);

    expect(result.top_signals).toHaveLength(0);
  });
});
