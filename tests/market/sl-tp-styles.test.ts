import { describe, it, expect } from 'vitest';
import { computeSlTpPrices } from '../../src/market/sl-tp-styles.js';
import type { Indicators } from '../../src/indicators/technical.js';

const baseInd: Indicators = {
  rsi: 55, ema20: 100, ema50: 98, atr: 2, trend: 'bullish',
  macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
  bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
  bollingerBandwidth: 10, bollingerPercentB: 0.5,
  volumeRatio: 1.2, vwap: 100, adx: 30,
};

describe('computeSlTpPrices', () => {
  it('fixed style uses raw percentages', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'fixed',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG', indicators: baseInd,
    });
    expect(result.slPrice).toBeCloseTo(97, 1);
    expect(result.tpPrice).toBeCloseTo(106, 1);
  });

  it('atr style uses ATR multiplier for SL', () => {
    const result = computeSlTpPrices({
      slStyle: 'atr', tpStyle: 'fixed',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG', indicators: { ...baseInd, atr: 3 },
    });
    // ATR SL = fillPrice - 1.5 * ATR = 100 - 4.5 = 95.5
    expect(result.slPrice).toBeCloseTo(95.5, 1);
    expect(result.tpPrice).toBeCloseTo(106, 1);
  });

  it('range style uses Bollinger bands', () => {
    const result = computeSlTpPrices({
      slStyle: 'range', tpStyle: 'range',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG',
      indicators: { ...baseInd, bollingerLower: 96, bollingerUpper: 104 },
    });
    expect(result.slPrice).toBeCloseTo(96, 0); // Bollinger lower
    expect(result.tpPrice).toBeCloseTo(104, 0); // Bollinger upper
  });

  it('trailing style tightens SL (80% of fixed)', () => {
    const result = computeSlTpPrices({
      slStyle: 'trailing', tpStyle: 'trailing',
      slPct: 5, tpPct: 10,
      fillPrice: 100, side: 'LONG', indicators: baseInd,
    });
    expect(result.slPrice).toBeCloseTo(96, 0);
    expect(result.tpPrice).toBeCloseTo(112, 0);
  });

  it('momentum TP uses 2x ATR', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'momentum',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG', indicators: { ...baseInd, atr: 4 },
    });
    expect(result.tpPrice).toBeCloseTo(108, 0);
  });

  it('SHORT side inverts SL/TP direction', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'fixed',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'SHORT', indicators: baseInd,
    });
    expect(result.slPrice).toBeCloseTo(103, 1);
    expect(result.tpPrice).toBeCloseTo(94, 1);
  });

  it('dca TP uses 50% of fixed (conservative exit)', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'dca',
      slPct: 5, tpPct: 10,
      fillPrice: 100, side: 'LONG', indicators: baseInd,
    });
    expect(result.tpPrice).toBeCloseTo(105, 0);
  });
});
