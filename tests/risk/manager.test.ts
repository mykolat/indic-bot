import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager, TradeDecision, PortfolioState, ValidationContext } from '../../src/risk/manager.js';

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
});
