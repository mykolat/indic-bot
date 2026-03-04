import { describe, it, expect, beforeEach } from 'vitest';
import { RiskManager, TradeDecision, PortfolioState } from '../../src/risk/manager.js';

describe('RiskManager', () => {
  const config = {
    maxLeverage: 10,
    maxPositionPct: 33,
    maxExposurePct: 50,
    maxStopLossPct: 3,
    maxLossUsd: 5,
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
      sessionPnl: 0,
    };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('rejects leverage above max', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 15, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('leverage');
  });

  it('rejects position exceeding max position pct', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 50,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('position');
  });

  it('rejects when total exposure would exceed max', () => {
    const decision: TradeDecision = {
      pair: 'ETHUSDT', action: 'LONG', size_pct: 30,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 10,
      positions: [{ pair: 'BTCUSDT', sizeUsd: 3, leverage: 5, side: 'LONG' }],
      sessionPnl: 0,
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
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('stop');
  });

  it('triggers shutdown when session loss exceeds max', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 4, positions: [], sessionPnl: -6 };

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
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    expect(rm.validate(hold, portfolio).approved).toBe(true);
  });
});
