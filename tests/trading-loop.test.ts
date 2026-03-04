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
});
