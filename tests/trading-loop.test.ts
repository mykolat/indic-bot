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
  let mockSoulKeeper: any;

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
    mockSoulKeeper = {
      read: vi.fn().mockReturnValue('# Trading Soul\n## Identity\nTest soul'),
      updateStats: vi.fn(),
      addRejection: vi.fn(),
      addInvisibleExit: vi.fn(),
      addExternalInsight: vi.fn(),
      writeNarrativeSections: vi.fn(),
    };

    loop = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: {
        load: vi.fn().mockReturnValue({ session_notes: '', recent_trades: [] }),
        addTrade: vi.fn(),
        updateNotes: vi.fn(),
        save: vi.fn(),
        getStartBalance: vi.fn().mockReturnValue(10),
        setStartBalance: vi.fn(),
        setLastOrderResult: vi.fn(),
        getLastOrderResult: vi.fn().mockReturnValue(undefined),
      } as any,
      newsCache: {
        shouldRefresh: vi.fn().mockReturnValue(false),
        getAnalysis: vi.fn().mockReturnValue(null),
        save: vi.fn(),
        appendHistory: vi.fn(),
        getRecentItems: vi.fn().mockReturnValue([]),
        dbCount: vi.fn().mockReturnValue(0),
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
      soulKeeper: mockSoulKeeper as any,
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

  it('computes sessionPnl from real balance delta', async () => {
    // startBalance was set to 10 by mock, now balance is 12 → sessionPnl = 2
    mockMarketData.getPortfolioState.mockResolvedValueOnce({
      balanceUsd: 12,
      positions: [],
      sessionPnl: 0,
    });
    mockLlm.analyze.mockResolvedValueOnce([]);

    await loop.runOnce();

    const perfCall = mockLogger.logPerformance.mock.calls[0][0];
    expect(perfCall.sessionPnl).toBeCloseTo(2);
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

  it('auto-closes stale positions (>8h, <1% P&L)', async () => {
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 100,
      sessionPnl: 0,
      positions: [{
        pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG',
        entryPrice: 50000, unrealizedPnlPct: 0.3, heldHours: 9,
      }],
    });
    mockOrders.close.mockResolvedValue({ success: true, orderId: 99 });
    mockLlm.analyze.mockResolvedValue([]);

    await loop.runOnce();

    expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');
    expect(mockLogger.logTrade).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'AUTO_CLOSE', reason: expect.stringContaining('stale') }),
    );
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

  // ── Soul integration tests ───────────────────────────────────────────

  it('passes soul content to llm.analyze', async () => {
    await loop.runOnce();
    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.soulContent).toContain('Trading Soul');
  });

  it('records RISK_REJECTED in soul', async () => {
    mockRisk.validate.mockReturnValue({ approved: false, reason: 'too risky' });
    await loop.runOnce();
    expect(mockSoulKeeper.addRejection).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'BTCUSDT', reason: 'too risky' }),
    );
  });

  it('records auto-close as invisible exit in soul', async () => {
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 100, sessionPnl: 0,
      positions: [{
        pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG',
        entryPrice: 50000, unrealizedPnlPct: 0.3, heldHours: 9,
      }],
    });
    mockOrders.close.mockResolvedValue({ success: true, orderId: 99 });
    mockLlm.analyze.mockResolvedValue([]);
    await loop.runOnce();
    expect(mockSoulKeeper.addInvisibleExit).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'BTCUSDT', type: 'AUTO_CLOSE' }),
    );
  });

  it('updates soul stats after each cycle', async () => {
    mockLlm.analyze.mockResolvedValue([]);
    await loop.runOnce();
    expect(mockSoulKeeper.updateStats).toHaveBeenCalled();
  });

  // ── Resilience tests ──────────────────────────────────────────────────

  it('uses fallbackLlm when Layer 1 (Codex) throws', async () => {
    const mockFallbackLlm = {
      analyze: vi.fn().mockResolvedValue([
        { pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'fallback' },
      ]),
    };
    mockLlm.analyze.mockRejectedValue(new Error('Codex 503'));

    const loopWithFallback = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      fallbackLlm: mockFallbackLlm as any,
    });

    await loopWithFallback.runOnce();

    expect(mockFallbackLlm.analyze).toHaveBeenCalled();
    expect(mockLogger.logError).toHaveBeenCalledWith('LLM_LAYER1_FAILED', expect.any(String));
  });

  it('enters Layer 3 (rule-based) when both Layer 1 and Layer 2 fail', async () => {
    const mockFallbackLlm = {
      analyze: vi.fn().mockRejectedValue(new Error('Fallback 429')),
    };
    mockLlm.analyze.mockRejectedValue(new Error('Codex 503'));

    const loopWithFallback = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      fallbackLlm: mockFallbackLlm as any,
    });

    await loopWithFallback.runOnce();

    expect(mockLogger.logError).toHaveBeenCalledWith('LLM_LAYER1_FAILED', expect.any(String));
    expect(mockLogger.logError).toHaveBeenCalledWith('LLM_LAYER2_FAILED', expect.any(String));
    // No positions with significant loss → no emergency close
    expect(mockOrders.close).not.toHaveBeenCalled();
  });

  it('Layer 3: auto-closes all positions on significant loss (-5%)', async () => {
    mockLlm.analyze.mockRejectedValue(new Error('Codex down'));
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 94,
      sessionPnl: -6,
      positions: [
        { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 100, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -6, heldHours: 2 },
      ],
    });
    mockMarketData.getSnapshot.mockResolvedValue({
      pair: 'BTCUSDT', candles1h: [], candles4h: [], candles15m: [],
      fundingRate: '0.0001', fundingHistory: [],
      openInterest: '80000', markPrice: '65800',
      longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
    });
    // startBalance = 100 → sessionPnlPct = (94 - 100)/100 * 100 = -6%
    loop['deps'].memory.getStartBalance = vi.fn().mockReturnValue(100);

    const loopL3 = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      // No fallbackLlm → straight to Layer 3
    });

    await loopL3.runOnce();

    expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');
    expect(mockLogger.logTrade).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EMERGENCY_CLOSE', pair: 'BTCUSDT' }),
    );
  });

  it('Layer 2: filters out LONG and SHORT decisions', async () => {
    const mockFallbackLlm = {
      analyze: vi.fn().mockResolvedValue([
        { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'rogue' },
        { pair: 'ETHUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'wait' },
      ]),
    };
    mockLlm.analyze.mockRejectedValue(new Error('Codex down'));

    const loopL2 = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      fallbackLlm: mockFallbackLlm as any,
    });

    await loopL2.runOnce();

    // LONG was filtered → execute not called
    expect(mockOrders.execute).not.toHaveBeenCalled();
  });

  it('skips cycle when Binance circuit breaker is open', async () => {
    // Force all snapshots to fail 3 times
    mockMarketData.getSnapshot.mockRejectedValue(new Error('Binance down'));

    for (let i = 0; i < 3; i++) {
      await loop.runOnce();
    }

    // 4th cycle: circuit breaker open → skipped, no LLM call
    mockLlm.analyze.mockClear();
    await loop.runOnce();

    expect(mockLlm.analyze).not.toHaveBeenCalled();
    expect(mockLogger.logError).toHaveBeenCalledWith(
      'CIRCUIT_BREAKER_OPEN',
      expect.any(String),
    );
  });

  it('continues with partial pairs when some snapshots fail', async () => {
    mockMarketData.getSnapshot = vi.fn().mockImplementation((pair: string) => {
      if (pair === 'BTCUSDT') return Promise.reject(new Error('BTC timeout'));
      return Promise.resolve({
        pair: 'ETHUSDT', candles1h: [], candles4h: [], candles15m: [],
        fundingRate: '0.0001', fundingHistory: [],
        openInterest: '80000', markPrice: '3000',
        longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
      });
    });

    const loopMulti = new TradingLoop({
      pairs: ['BTCUSDT', 'ETHUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    });

    await loopMulti.runOnce();

    // LLM called with 1 snapshot (ETHUSDT only)
    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.snapshots).toHaveLength(1);
    expect(callArg.snapshots[0].pair).toBe('ETHUSDT');
  });
});
