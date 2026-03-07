import { describe, it, expect } from 'vitest';
import { RegimeHysteresis } from '../../src/market/regime-hysteresis.js';
import { MarketRegime } from '../../src/market/regime-classifier.js';

describe('RegimeHysteresis', () => {
  it('does not switch regime until stable for N cycles', () => {
    const h = new RegimeHysteresis(3);
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.Range);
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.Range);
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.BullTrend);
  });

  it('resets counter on regime change', () => {
    const h = new RegimeHysteresis(3);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('BTCUSDT', MarketRegime.Range); // interrupt
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.Range); // counter reset
  });

  it('switches immediately to Capitulation', () => {
    const h = new RegimeHysteresis(3);
    expect(h.update('BTCUSDT', MarketRegime.Capitulation)).toBe(MarketRegime.Capitulation);
  });

  it('tracks pairs independently', () => {
    const h = new RegimeHysteresis(2);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('ETHUSDT', MarketRegime.BearTrend);
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.BullTrend);
    expect(h.update('ETHUSDT', MarketRegime.BearTrend)).toBe(MarketRegime.BearTrend);
  });

  it('returns current confirmed regime via get()', () => {
    const h = new RegimeHysteresis(2);
    expect(h.get('BTCUSDT')).toBe(MarketRegime.Range);
    h.update('BTCUSDT', MarketRegime.Breakout);
    h.update('BTCUSDT', MarketRegime.Breakout);
    expect(h.get('BTCUSDT')).toBe(MarketRegime.Breakout);
  });
});
