import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/news/fear-greed.js', () => ({
  fetchFearGreed: vi.fn().mockResolvedValue({ value: 50, label: 'Neutral' }),
}));

import { TradingLoop } from '../src/trading-loop.js';

describe('TradingLoop', () => {
  let loop: TradingLoop;
  let mockMarketData: any;
  let mockLlm: any;
  let mockOrders: any;
  let mockRisk: any;
  let mockSignalBuffer: any;
  let mockLogger: any;

  beforeEach(() => {
    mockMarketData = {
      getSnapshot: vi.fn().mockResolvedValue({
        pair: 'BTCUSDT', candles1h: [], candles4h: [],
        fundingRate: '0.0001', openInterest: '80000', markPrice: '50000',
      }),
      getPortfolioState: vi.fn().mockResolvedValue({
        balanceUsd: 10, positions: [], sessionPnl: 0,
      }),
    };
    mockLlm = {
      analyze: vi.fn().mockResolvedValue([
        { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'bullish' },
      ]),
    };
    mockOrders = {
      execute: vi.fn().mockResolvedValue({ success: true, orderId: 123 }),
      close: vi.fn().mockResolvedValue({ success: true }),
    };
    mockRisk = {
      validate: vi.fn().mockReturnValue({ approved: true }),
    };
    mockSignalBuffer = {
      drain: vi.fn().mockReturnValue([]),
    };
    mockLogger = {
      logDecision: vi.fn(),
      logTrade: vi.fn(),
      logError: vi.fn(),
      logPerformance: vi.fn(),
    };

    loop = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: { load: vi.fn().mockReturnValue({ session_notes: '', recent_trades: [] }), addTrade: vi.fn(), updateNotes: vi.fn(), save: vi.fn() } as any,
      newsCache: {
        shouldRefresh: vi.fn().mockReturnValue(false),
        getAnalysis: vi.fn().mockReturnValue(null),
        save: vi.fn(),
        appendHistory: vi.fn(),
      },
      newsAnalyst: {
        analyze: vi.fn().mockResolvedValue({
          market_summary: 'test',
          top_signals: [],
          overall_sentiment: 'neutral',
          macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
          risk_events: [],
        }),
      },
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    });
  });

  it('runs a full cycle: fetch → analyze → validate → execute → log', async () => {
    await loop.runOnce();

    expect(mockMarketData.getSnapshot).toHaveBeenCalledWith('BTCUSDT');
    expect(mockMarketData.getPortfolioState).toHaveBeenCalled();
    expect(mockLlm.analyze).toHaveBeenCalled();
    expect(mockRisk.validate).toHaveBeenCalled();
    expect(mockOrders.execute).toHaveBeenCalled();
    expect(mockLogger.logDecision).toHaveBeenCalled();
    expect(mockLogger.logTrade).toHaveBeenCalled();
  });

  it('skips execution when risk manager rejects', async () => {
    mockRisk.validate.mockReturnValue({ approved: false, reason: 'too risky' });

    await loop.runOnce();

    expect(mockOrders.execute).not.toHaveBeenCalled();
    expect(mockLogger.logDecision).toHaveBeenCalled();
  });

  it('skips execution for HOLD decisions', async () => {
    mockLlm.analyze.mockResolvedValue([
      { pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'no signal' },
    ]);

    await loop.runOnce();

    expect(mockOrders.execute).not.toHaveBeenCalled();
  });

  it('stops when risk manager triggers shutdown', async () => {
    mockRisk.validate.mockReturnValue({ approved: false, reason: 'max loss', shutdown: true });

    await loop.runOnce();

    expect(loop.isShutdown()).toBe(true);
  });

  it('logs errors when order execution fails', async () => {
    mockOrders.execute.mockResolvedValue({ success: false, error: 'Insufficient margin' });

    await loop.runOnce();

    expect(mockLogger.logError).toHaveBeenCalled();
  });

  it('skips LONG/SHORT within cooldown after closing same pair', async () => {
    // Cycle 1: close a position
    mockLlm.analyze.mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 1, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'exit' },
    ]);
    mockMarketData.getPortfolioState.mockResolvedValueOnce({
      balanceUsd: 10,
      positions: [{ pair: 'BTCUSDT', side: 'LONG', sizeUsd: 5, leverage: 5, entryPrice: 50000, unrealizedPnlPct: 0, heldHours: 1 }],
      sessionPnl: 0,
    });
    await loop.runOnce();
    expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');

    // Cycle 2: LLM wants LONG again immediately — should be blocked
    mockOrders.execute.mockClear();
    mockLlm.analyze.mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 're-enter' },
    ]);
    await loop.runOnce();
    expect(mockOrders.execute).not.toHaveBeenCalled();
  });
});
