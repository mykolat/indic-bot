import { describe, it, expect } from 'vitest';
import {
  classifyRegime,
  MarketRegime,
  type RegimeResult,
  type RegimeContext,
} from '../../src/market/regime-classifier.js';
import type { Indicators } from '../../src/indicators/technical.js';

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    rsi: 50,
    ema20: 100,
    ema50: 100,
    atr: 1.5,
    trend: 'neutral',
    macd: 0,
    macdSignal: 0,
    macdHistogram: 0,
    bollingerUpper: 105,
    bollingerMiddle: 100,
    bollingerLower: 95,
    bollingerBandwidth: 10,
    bollingerPercentB: 50,
    volumeRatio: 1.0,
    vwap: 100,
    adx: 15,
    ...overrides,
  };
}

describe('classifyRegime', () => {
  it('detects bull_trend (EMA20 > EMA50, ADX > 25, price > VWAP)', () => {
    const ind = makeIndicators({
      ema20: 105,
      ema50: 100,
      adx: 30,
      vwap: 102,
    });
    const result = classifyRegime(ind, 104, { value: 50 });
    expect(result.regime).toBe(MarketRegime.BullTrend);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('detects bear_trend (EMA20 < EMA50, ADX > 25, price < VWAP)', () => {
    const ind = makeIndicators({
      ema20: 95,
      ema50: 100,
      adx: 30,
      vwap: 102,
    });
    const result = classifyRegime(ind, 98, { value: 50 });
    expect(result.regime).toBe(MarketRegime.BearTrend);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('detects range (ADX < 20, BB bandwidth < 4%)', () => {
    const ind = makeIndicators({
      adx: 15,
      bollingerBandwidth: 3,
    });
    const result = classifyRegime(ind, 100, { value: 50 });
    expect(result.regime).toBe(MarketRegime.Range);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('detects breakout (volume > 1.5x, price outside BB)', () => {
    const ind = makeIndicators({
      volumeRatio: 2.0,
      bollingerPercentB: 110, // above upper band
      adx: 22,
    });
    const result = classifyRegime(ind, 106, { value: 50 });
    expect(result.regime).toBe(MarketRegime.Breakout);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('detects breakout with ATR spike and high volume', () => {
    const ind = makeIndicators({
      volumeRatio: 1.8,
      atr: 3.0,
      adx: 22,
    });
    const ctx: RegimeContext = { prevAtr: 1.5 }; // ATR spike = 3.0/1.5 = 2.0 > 1.5
    const result = classifyRegime(ind, 100, { value: 50 }, ctx);
    expect(result.regime).toBe(MarketRegime.Breakout);
  });

  it('detects capitulation (F&G < 15)', () => {
    const ind = makeIndicators({ adx: 30, ema20: 105, ema50: 100, vwap: 99 });
    const result = classifyRegime(ind, 104, { value: 10 });
    expect(result.regime).toBe(MarketRegime.Capitulation);
  });

  it('detects capitulation from extreme volume (> 3x)', () => {
    const ind = makeIndicators({ volumeRatio: 3.5 });
    const result = classifyRegime(ind, 100, { value: 50 });
    expect(result.regime).toBe(MarketRegime.Capitulation);
  });

  it('capitulation overrides other regimes', () => {
    // Bull trend conditions + capitulation F&G
    const ind = makeIndicators({
      ema20: 105,
      ema50: 100,
      adx: 30,
      vwap: 99,
    });
    const result = classifyRegime(ind, 104, { value: 8 });
    expect(result.regime).toBe(MarketRegime.Capitulation);
  });

  it('returns factors explaining classification', () => {
    const ind = makeIndicators({
      ema20: 105,
      ema50: 100,
      adx: 30,
      vwap: 102,
    });
    const result = classifyRegime(ind, 104, { value: 50 });
    expect(result.factors).toBeInstanceOf(Array);
    expect(result.factors.length).toBeGreaterThan(0);
    result.factors.forEach((f) => expect(typeof f).toBe('string'));
  });

  it('defaults to Range with low confidence when no strong signals', () => {
    const ind = makeIndicators({
      ema20: 100,
      ema50: 100,
      adx: 18,
      bollingerBandwidth: 6, // > 4%, so not strong range
      volumeRatio: 1.0,
    });
    const result = classifyRegime(ind, 100, { value: 50 });
    expect(result.regime).toBe(MarketRegime.Range);
    expect(result.confidence).toBeLessThan(50);
  });

  it('defaults to weak BullTrend from EMA alignment when ADX is low', () => {
    const ind = makeIndicators({
      ema20: 105,
      ema50: 100,
      adx: 18,
      bollingerBandwidth: 6,
      volumeRatio: 1.0,
    });
    const result = classifyRegime(ind, 100, { value: 50 });
    expect(result.regime).toBe(MarketRegime.BullTrend);
    expect(result.confidence).toBeLessThan(50);
  });
});
