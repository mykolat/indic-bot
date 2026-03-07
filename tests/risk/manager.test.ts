import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager, TradeDecision, PortfolioState, ValidationContext, AdjustContext, BETA_TO_BTC, DecisionEnvelope, RiskExtraContext } from '../../src/risk/manager.js';

describe('RiskManager', () => {
  const config = {
    maxLeverage: 10,
    maxPositionPct: 33,
    maxExposurePct: 50,
    maxStopLossPct: 3,
    maxLossUsd: 5,
    maxLossPct: 0,
    maxDrawdownPct: 15,
  };

  let rm: RiskManager;

  beforeEach(() => {
    rm = new RiskManager(config);
  });

  it('approves a valid trade', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 5,
      stop_loss_pct: 2,
      take_profit_pct: 4,
      reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 10,
      positions: [],
      sessionPnl: 0, drawdownPct: 0,
    };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('rejects leverage above max', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 15, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0, drawdownPct: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('leverage');
  });

  it('rejects position exceeding max position pct', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 50,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0, drawdownPct: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('position');
  });

  it('rejects when total exposure would exceed max', () => {
    const decision: TradeDecision = {
      pair: 'ETHUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    // Existing position: sizeUsd=$300 notional, leverage=5x → margin=$60 = 60% of $100 balance
    // New trade: 20% of $100 = $20 margin
    // Total = 60% + 20% = 80% > maxExposurePct(50%) → rejected
    const portfolio: PortfolioState = {
      balanceUsd: 100,
      positions: [{ pair: 'BTCUSDT', sizeUsd: 300, leverage: 5, side: 'LONG', entryPrice: 50000, unrealizedPnlPct: 1.5, heldHours: 2 }],
      sessionPnl: 0, drawdownPct: 0,
    };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('exposure');
  });

  it('rejects correlated longs when beta-adjusted exposure exceeds max', () => {
    // 3 correlated longs: SOL ($100/5x=$20, beta 1.8=36), DOGE ($100/5x=$20, beta 2.0=40), existing
    // New: ETH 20% of $500=$100 margin, beta 1.3=130... let's simplify
    // Balance $1000, maxExposure 50%
    // Existing: SOLUSDT $500/5x = $100 margin × 1.8 beta = $180 long
    // New: ETHUSDT 10% of $1000 = $100 margin × 1.3 beta = $130 long
    // Gross = 310, net = 310, effective = max(310, 155) = 310
    // 310/1000 = 31% — under 50%. Need bigger positions.
    // Existing: SOLUSDT $2000/5x = $400 margin × 1.8 = $720 long
    // New: DOGEUSDT 10% = $100 × 2.0 = $200
    // effective = max(920, 460) = 920 → 92% > 50%
    const decision: TradeDecision = {
      pair: 'DOGEUSDT', action: 'LONG', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000,
      positions: [{ pair: 'SOLUSDT', sizeUsd: 2000, leverage: 5, side: 'LONG', entryPrice: 100, unrealizedPnlPct: 1, heldHours: 2 }],
      sessionPnl: 0, drawdownPct: 0,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('beta-adjusted exposure');
  });

  it('reduces effective exposure for hedged (opposing) positions', () => {
    // Long BTC $500/5x = $100 margin × 1.0 = $100 long
    // New: Short ETH 10% of $1000 = $100 margin × 1.3 = $130 short
    // net = |100 - 130| = 30, gross = 230, effective = max(30, 115) = 115
    // Without beta hedge awareness this would be higher
    // 115/1000 = 11.5% < 50% → approved
    const decision: TradeDecision = {
      pair: 'ETHUSDT', action: 'SHORT', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000,
      positions: [{ pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG', entryPrice: 50000, unrealizedPnlPct: 1, heldHours: 2 }],
      sessionPnl: 0, drawdownPct: 0,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('defaults to beta=1.0 for unknown pairs', () => {
    expect(BETA_TO_BTC['UNKNOWNUSDT']).toBeUndefined();
    // Unknown pair should still work — beta defaults to 1.0
    const decision: TradeDecision = {
      pair: 'UNKNOWNUSDT', action: 'LONG', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('rejects missing stop-loss', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 0, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0, drawdownPct: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('stop');
  });

  it('triggers shutdown when session loss exceeds max', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 4, positions: [], sessionPnl: -6, drawdownPct: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('shutdown');
    expect(result.shutdown).toBe(true);
  });

  it('passes through HOLD and CLOSE without validation', () => {
    const hold: TradeDecision = {
      pair: 'BTCUSDT', action: 'HOLD', size_pct: 0,
      leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'wait',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0, drawdownPct: 0 };

    expect(rm.validate(hold, portfolio).approved).toBe(true);
  });

  it('uses maxLossPct % of balance when set', () => {
    const rm = new RiskManager({
      maxLeverage: 20, maxPositionPct: 50, maxExposurePct: 150,
      maxStopLossPct: 5, maxLossUsd: 5, maxLossPct: 10, maxDrawdownPct: 15,
    });
    const decision = { pair: 'BTCUSDT', action: 'LONG' as const, size_pct: 10, leverage: 2, stop_loss_pct: 2, take_profit_pct: 5, reasoning: '' };

    // $4.9 loss on $50 = 9.8% — below 10% threshold → approved
    expect(rm.validate(decision, { balanceUsd: 50, positions: [], sessionPnl: -4.9, drawdownPct: 0 }).approved).toBe(true);

    // $5.1 loss on $50 = 10.2% — exceeds 10% → shutdown
    expect(rm.validate(decision, { balanceUsd: 50, positions: [], sessionPnl: -5.1, drawdownPct: 0 }).shutdown).toBe(true);
  });

  it('rejects low-confidence decisions', () => {
    const rm = new RiskManager({ ...config, minConfidence: 60 });
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'weak signal',
      confidence: 45,
    };
    const portfolio: PortfolioState = { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('confidence');
  });

  it('approves high-confidence decisions', () => {
    const rm = new RiskManager({ ...config, minConfidence: 60 });
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'strong setup',
      confidence: 85,
    };
    const portfolio: PortfolioState = { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('falls back to maxLossUsd when maxLossPct is 0', () => {
    const rm = new RiskManager({
      maxLeverage: 20, maxPositionPct: 50, maxExposurePct: 150,
      maxStopLossPct: 5, maxLossUsd: 5, maxLossPct: 0, maxDrawdownPct: 15,
    });
    const decision = { pair: 'BTCUSDT', action: 'LONG' as const, size_pct: 10, leverage: 2, stop_loss_pct: 2, take_profit_pct: 5, reasoning: '' };

    expect(rm.validate(decision, { balanceUsd: 1000, positions: [], sessionPnl: -4.9, drawdownPct: 0 }).approved).toBe(true);
    expect(rm.validate(decision, { balanceUsd: 1000, positions: [], sessionPnl: -5.1, drawdownPct: 0 }).shutdown).toBe(true);
  });

  describe('Hard guardrails', () => {
    const basePortfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };

    it('rejects LONG when 4h bearish and confidence < 80', () => {
      const decision: TradeDecision = {
        pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
        stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 65,
      };
      const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
      const result = rm.validate(decision, basePortfolio, ctx);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('4h trend bearish');
    });

    it('allows LONG against 4h if confidence >= 80', () => {
      const decision: TradeDecision = {
        pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
        stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 85,
      };
      const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
      const result = rm.validate(decision, basePortfolio, ctx);
      expect(result.approved).toBe(true);
    });

    it('caps leverage in extreme Fear & Greed', () => {
      const highLevRm = new RiskManager({ ...config, maxLeverage: 20 });
      const decision: TradeDecision = {
        pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 15,
        stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
      };
      const ctx = { fearGreed: { value: 20 }, fearGreedLeverageCap: 10 };
      const result = highLevRm.validate(decision, basePortfolio, ctx);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Extreme F&G');
    });

    it('reduces leverage on session loss > 5%', () => {
      const portfolio = { ...basePortfolio, balanceUsd: 100, sessionPnl: -6, drawdownPct: 0 };
      const decision: TradeDecision = {
        pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 8,
        stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
      };
      const result = rm.validate(decision, portfolio);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Session loss');
    });

    it('rejects duplicate position', () => {
      const portfolio = {
        ...basePortfolio,
        positions: [{ pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG' as const, entryPrice: 50000, unrealizedPnlPct: 1, heldHours: 2 }],
      };
      const decision: TradeDecision = {
        pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
        stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
      };
      const result = rm.validate(decision, portfolio);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Already LONG');
    });
  });

  describe('computeEnvelope', () => {
    const envPortfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };

    it('returns base envelope with no constraints', () => {
      const envelope = rm.computeEnvelope(envPortfolio, {});
      expect(envelope.maxLeverage).toBe(10);
      expect(envelope.maxSizePct).toBe(33);
      expect(envelope.recommendedLeverage[0]).toBeGreaterThan(0);
      expect(envelope.recommendedLeverage[1]).toBeLessThanOrEqual(10);
      expect(envelope.constraints).toEqual([]);
    });

    it('caps leverage on extreme F&G', () => {
      const envelope = rm.computeEnvelope(envPortfolio, { fearGreed: { value: 20 }, fearGreedLeverageCap: 5 });
      expect(envelope.maxLeverage).toBe(5);
      expect(envelope.constraints).toContain('extreme_fear_greed');
    });

    it('scales down on session loss >= 5%', () => {
      const lossPortfolio = { ...envPortfolio, balanceUsd: 100, sessionPnl: -6, drawdownPct: 0 };
      const envelope = rm.computeEnvelope(lossPortfolio, {});
      expect(envelope.maxLeverage).toBe(5);
      expect(envelope.maxSizePct).toBe(16);
      expect(envelope.constraints).toContain('session_loss_scaling');
    });

    it('applies severe scaling on session loss >= 10%', () => {
      const lossPortfolio = { ...envPortfolio, balanceUsd: 100, sessionPnl: -11, drawdownPct: 0 };
      const envelope = rm.computeEnvelope(lossPortfolio, {});
      expect(envelope.maxLeverage).toBe(5);
      expect(envelope.maxSizePct).toBe(25);
      expect(envelope.constraints).toContain('session_loss_severe');
    });

    it('applies weekend multiplier', () => {
      const envelope = rm.computeEnvelope(envPortfolio, { isWeekend: true, weekendLeverageMultiplier: 0.5 });
      expect(envelope.maxLeverage).toBe(5);
      expect(envelope.constraints).toContain('weekend_mode');
    });

    it('applies regime reduction', () => {
      const envelope = rm.computeEnvelope(envPortfolio, { regimeLeverageMultiplier: 0.25 });
      expect(envelope.maxLeverage).toBe(3);
      expect(envelope.constraints).toContain('regime_reduction');
    });

    it('lists blocked pairs from existing positions', () => {
      const portfolio = {
        ...envPortfolio,
        positions: [{ pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG' as const, entryPrice: 50000, unrealizedPnlPct: 1, heldHours: 2 }],
      };
      const envelope = rm.computeEnvelope(portfolio, {});
      expect(envelope.blockedPairs).toEqual(['BTCUSDT:LONG']);
    });

    it('stacks multiple constraints', () => {
      const lossPortfolio = { ...envPortfolio, balanceUsd: 100, sessionPnl: -6, drawdownPct: 0 };
      const envelope = rm.computeEnvelope(lossPortfolio, { isWeekend: true, weekendLeverageMultiplier: 0.5, fearGreed: { value: 90 }, fearGreedLeverageCap: 8 });
      expect(envelope.constraints).toContain('extreme_fear_greed');
      expect(envelope.constraints).toContain('session_loss_scaling');
      expect(envelope.constraints).toContain('weekend_mode');
      expect(envelope.maxLeverage).toBeLessThanOrEqual(4);
    });
  });

  describe('Daily loss limit', () => {
    const basePortfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };
    const baseDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
    };

    it('rejects trade when daily loss exceeds limit (shutdown)', () => {
      const rm = new RiskManager({ ...config, maxDailyLossPct: 5 });
      const extra: RiskExtraContext = { dailyRealizedPnl: -55 }; // -55 on $1000 = 5.5% > 5%
      const result = rm.validate(baseDecision, basePortfolio, undefined, undefined, extra);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Daily loss');
      expect(result.shutdown).toBe(true);
    });

    it('allows trade when daily loss is within limit', () => {
      const rm = new RiskManager({ ...config, maxDailyLossPct: 5 });
      const extra: RiskExtraContext = { dailyRealizedPnl: -40 }; // -40 on $1000 = 4% < 5%
      const result = rm.validate(baseDecision, basePortfolio, undefined, undefined, extra);
      expect(result.approved).toBe(true);
    });
  });

  describe('Abnormal spread guard', () => {
    const basePortfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };
    const baseDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
    };

    it('rejects when spread > 2.5x median with enough samples', () => {
      const extra: RiskExtraContext = { spreadPct: 0.003, medianSpreadPct: 0.001, spreadSampleSize: 25 };
      const result = rm.validate(baseDecision, basePortfolio, undefined, undefined, extra);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Abnormal spread');
    });

    it('allows when spread is normal', () => {
      const extra: RiskExtraContext = { spreadPct: 0.001, medianSpreadPct: 0.001, spreadSampleSize: 25 };
      const result = rm.validate(baseDecision, basePortfolio, undefined, undefined, extra);
      expect(result.approved).toBe(true);
    });

    it('skips check when sample size < 20', () => {
      const extra: RiskExtraContext = { spreadPct: 0.01, medianSpreadPct: 0.001, spreadSampleSize: 10 };
      const result = rm.validate(baseDecision, basePortfolio, undefined, undefined, extra);
      expect(result.approved).toBe(true);
    });
  });

  describe('ADJUST validation', () => {
    const adjustPortfolio: PortfolioState = {
      balanceUsd: 1000,
      availableUsd: 500,
      positions: [{ pair: 'ADAUSDT', sizeUsd: 200, leverage: 5, side: 'SHORT', entryPrice: 0.27, unrealizedPnlPct: 8.0, heldHours: 4 }],
      sessionPnl: 0,
      drawdownPct: 0,
    };

    const baseAdjustCtx: AdjustContext = {
      currentSlPrice: 0.2759,   // 2.2% above entry for SHORT
      currentTpPrice: 0.2495,
      entryPrice: 0.27,
      side: 'SHORT',
    };

    it('approves ADJUST that tightens SL for SHORT', () => {
      // SL at 1.5% above entry = 0.27 * 1.015 = 0.27405 — tighter than current 0.2759
      const decision: TradeDecision = {
        pair: 'ADAUSDT', action: 'ADJUST', size_pct: 0, leverage: 0,
        stop_loss_pct: 1.5, take_profit_pct: 7.5, reasoning: 'tighten SL',
      };
      // Use portfolio with PnL < 5% to avoid breakeven lock
      const lowPnlPortfolio: PortfolioState = {
        ...adjustPortfolio,
        positions: [{ pair: 'ADAUSDT', sizeUsd: 200, leverage: 5, side: 'SHORT', entryPrice: 0.27, unrealizedPnlPct: 2.0, heldHours: 4 }],
      };
      const result = rm.validate(decision, lowPnlPortfolio, undefined, baseAdjustCtx);
      expect(result.approved).toBe(true);
    });

    it('rejects ADJUST that loosens SL (ratchet violation)', () => {
      // SL at 3.0% above entry = 0.27 * 1.03 = 0.2781 — wider than current 0.2759
      const decision: TradeDecision = {
        pair: 'ADAUSDT', action: 'ADJUST', size_pct: 0, leverage: 0,
        stop_loss_pct: 3.0, take_profit_pct: 7.5, reasoning: 'loosen SL',
      };
      const result = rm.validate(decision, adjustPortfolio, undefined, baseAdjustCtx);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Ratchet');
    });

    it('approves profit-lock SL (negative stop_loss_pct)', () => {
      // SL at -3.0% → for SHORT: 0.27 * (1 + (-3)/100) = 0.27 * 0.97 = 0.2619 — below entry, locks profit
      const decision: TradeDecision = {
        pair: 'ADAUSDT', action: 'ADJUST', size_pct: 0, leverage: 0,
        stop_loss_pct: -3.0, take_profit_pct: 7.5, reasoning: 'lock 3% profit',
      };
      const result = rm.validate(decision, adjustPortfolio, undefined, baseAdjustCtx);
      expect(result.approved).toBe(true);
    });
  });
});
