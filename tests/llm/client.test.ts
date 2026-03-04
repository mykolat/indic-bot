import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient } from '../../src/llm/client.js';
import type { MarketSnapshot } from '../../src/binance/market-data.js';
import type { TradingViewSignal } from '../../src/webhook/signal-buffer.js';
import type { PortfolioState } from '../../src/risk/manager.js';

describe('LLMClient', () => {
  let llm: LLMClient;
  let mockOpenAI: any;

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
    mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  decisions: [{
                    pair: 'BTCUSDT',
                    action: 'LONG',
                    size_pct: 20,
                    leverage: 5,
                    stop_loss_pct: 2,
                    take_profit_pct: 4,
                    reasoning: 'bullish momentum',
                  }],
                }),
              },
            }],
          }),
        },
      },
    };
    llm = new LLMClient(mockOpenAI, 'gpt-4o');
  });

  it('returns parsed trade decisions from GPT', async () => {
    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].pair).toBe('BTCUSDT');
    expect(decisions[0].action).toBe('LONG');
    expect(decisions[0].leverage).toBe(5);
  });

  it('handles GPT returning HOLD for all pairs', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            decisions: [{ pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'sideways market' }],
          }),
        },
      }],
    });

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions[0].action).toBe('HOLD');
  });

  it('includes TradingView signals in context', async () => {
    const signals: TradingViewSignal[] = [
      { signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 72, timeframe: '1h' },
    ];

    await llm.analyze([fakeSnapshot], fakePortfolio, signals);

    const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('RSI');
    expect(userMsg.content).toContain('BUY');
  });

  it('returns empty decisions on parse error', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    });

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions).toHaveLength(0);
  });
});
