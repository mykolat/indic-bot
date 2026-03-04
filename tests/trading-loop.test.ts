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
        pair: 'BTCUSDT', candles1h: [], candles4h: [], candles15m: [],
        fundingRate: '0.0001', fundingHistory: [],
        openInterest: '80000', markPrice: '50000',
        longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
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

  it('tracks OI delta across cycles', async () => {
    let callCount = 0;
    mockMarketData.getSnapshot = vi.fn().mockImplementation(() => Promise.resolve({
      pair: 'BTCUSDT', candles1h: [], candles4h: [], candles15m: [],
      fundingRate: '0.0001', fundingHistory: [],
      openInterest: callCount++ === 0 ? '1000' : '1200',
      markPrice: '50000',
      longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
    }));

    await loop.runOnce(); // cycle 1 — stores OI=1000
    await loop.runOnce(); // cycle 2 — OI=1200, delta=+20%

    const calls = mockLlm.analyze.mock.calls;
    const secondCallData = calls[1][0];
    expect(secondCallData.snapshots[0].openInterestDelta).toBeCloseTo(20);
  });

  it('accumulates sessionPnl after successful CLOSE', async () => {
    mockLlm.analyze.mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 1, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'exit' },
    ]);
    mockMarketData.getPortfolioState.mockResolvedValueOnce({
      balanceUsd: 1000,
      positions: [{
        pair: 'BTCUSDT', side: 'LONG',
        sizeUsd: 100, leverage: 5,
        entryPrice: 50000, unrealizedPnlPct: 8, heldHours: 2,
      }],
      sessionPnl: 0,
    });
    mockOrders.close.mockResolvedValueOnce({ success: true, orderId: 99 });

    await loop.runOnce();

    // sessionPnl passed to logPerformance should reflect the closed trade
    // sizeUsd = $100 notional, leverage = 5x → margin = $20
    // unrealizedPnlPct = 8% of margin → pnlUsd = 8 * 20 / 100 = $1.60
    const perfCall = mockLogger.logPerformance.mock.calls[0][0];
    expect(perfCall.sessionPnl).toBeCloseTo(1.60);
  });

  it('computes and passes 4h indicators to llm.analyze', async () => {
    const make4hCandles = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        openTime: i, open: '50000', high: '51000', low: '49000',
        close: String(50000 + i * 10), volume: '100',
      }));

    mockMarketData.getSnapshot.mockResolvedValueOnce({
      pair: 'BTCUSDT',
      candles1h: [],
      candles4h: make4hCandles(50),
      candles15m: [],
      fundingRate: '0.0001', fundingHistory: [],
      openInterest: '80000', markPrice: '50000',
      longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
    });

    await loop.runOnce();

    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.indicators4h).toBeDefined();
    expect(callArg.indicators4h.has('BTCUSDT')).toBe(true);
    const ind4h = callArg.indicators4h.get('BTCUSDT');
    expect(typeof ind4h.rsi).toBe('number');
  });

  it('omits 4h indicators when candles4h has fewer than 20 entries', async () => {
    const makeCandles = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        openTime: i, open: '50000', high: '51000', low: '49000',
        close: String(50000 + i * 10), volume: '100',
      }));

    mockMarketData.getSnapshot.mockResolvedValueOnce({
      pair: 'BTCUSDT',
      candles1h: [],
      candles4h: makeCandles(10), // < 20 — should be skipped
      candles15m: [],
      fundingRate: '0.0001', fundingHistory: [],
      openInterest: '80000', markPrice: '50000',
      longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
    });

    await loop.runOnce();

    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.indicators4h.has('BTCUSDT')).toBe(false);
  });

  it('records closed trade to memory after successful CLOSE', async () => {
    mockLlm.analyze.mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 1, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'exit' },
    ]);
    mockMarketData.getPortfolioState.mockResolvedValueOnce({
      balanceUsd: 1000,
      positions: [{
        pair: 'BTCUSDT', side: 'LONG',
        sizeUsd: 100, leverage: 5,
        entryPrice: 50000, unrealizedPnlPct: 5, heldHours: 2,
      }],
      sessionPnl: 0,
    });
    mockOrders.close.mockResolvedValueOnce({ success: true, orderId: 99 });

    const mockMemory = loop['deps'].memory as any;
    mockMemory.addTrade.mockClear();

    await loop.runOnce();

    expect(mockMemory.addTrade).toHaveBeenCalledOnce();
    const tradeArg = mockMemory.addTrade.mock.calls[0][0];
    expect(tradeArg.pair).toBe('BTCUSDT');
    expect(tradeArg.action).toBe('CLOSE');
    expect(tradeArg.pnlPct).toBe(5);
    expect(tradeArg.pnlUsd).toBeCloseTo(1.0); // 5% of ($100/5) margin = 5% of $20 = $1.00
    expect(typeof tradeArg.closedAt).toBe('string');
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
