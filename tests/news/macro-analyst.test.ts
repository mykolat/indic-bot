import { describe, it, expect, vi } from 'vitest';
import { MacroAnalystAgent } from '../../src/news/macro-analyst.js';

describe('MacroAnalystAgent', () => {
  it('parses valid macro analysis from LLM response', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        macro_summary: 'DXY strengthening, risk-off environment.',
        risk_environment: 'risk_off',
        crypto_correlation_signal: 'bearish',
        key_levels: ['DXY 104 resistance', 'VIX 20 threshold'],
        refreshed_at: '2026-03-04T19:00:00Z',
      })),
    };

    const agent = new MacroAnalystAgent(mockLlm);
    const result = await agent.analyze([
      { symbol: 'DXY', name: 'DXY Index', price: 104.2, change24h: 0.8, changeWeek: 1.2, dayHigh: 104.5, dayLow: 103.8 },
    ]);

    expect(result.risk_environment).toBe('risk_off');
    expect(result.crypto_correlation_signal).toBe('bearish');
    expect(result.key_levels).toHaveLength(2);
  });

  it('returns fallback on LLM error', async () => {
    const mockLlm = { call: vi.fn().mockRejectedValue(new Error('timeout')) };
    const agent = new MacroAnalystAgent(mockLlm);
    const result = await agent.analyze([]);
    expect(result.risk_environment).toBe('neutral');
  });
});
