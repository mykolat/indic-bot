import { describe, it, expect } from 'vitest';
import { interpretFundingRate, interpretOIDivergence, interpretOBI } from '../../src/market/signals.js';

describe('interpretFundingRate', () => {
  it('returns OVERCROWDED_LONGS for funding > 0.05%', () => {
    const signal = interpretFundingRate(0.0008); // 0.08%
    expect(signal.label).toBe('OVERCROWDED_LONGS');
    expect(signal.direction).toBe('bearish');
  });

  it('returns OVERCROWDED_SHORTS for funding < -0.05%', () => {
    const signal = interpretFundingRate(-0.0006); // -0.06%
    expect(signal.label).toBe('OVERCROWDED_SHORTS');
    expect(signal.direction).toBe('bullish');
  });

  it('returns NEUTRAL for normal funding', () => {
    const signal = interpretFundingRate(0.0002); // 0.02%
    expect(signal.label).toBe('NEUTRAL');
    expect(signal.direction).toBe('neutral');
  });

  it('returns EXTREME_LONGS for funding > 0.1%', () => {
    const signal = interpretFundingRate(0.0015); // 0.15%
    expect(signal.label).toBe('EXTREME_LONGS');
    expect(signal.direction).toBe('bearish');
  });

  it('returns EXTREME_SHORTS for funding < -0.1%', () => {
    const signal = interpretFundingRate(-0.0012); // -0.12%
    expect(signal.label).toBe('EXTREME_SHORTS');
    expect(signal.direction).toBe('bullish');
  });
});

describe('interpretOIDivergence', () => {
  it('returns TREND_CONTINUATION for price up + OI up', () => {
    const signal = interpretOIDivergence(2.0, 3.0);
    expect(signal.label).toBe('TREND_CONTINUATION');
    expect(signal.direction).toBe('bullish');
  });

  it('returns SHORT_SQUEEZE for price up + OI down', () => {
    const signal = interpretOIDivergence(1.5, -2.0);
    expect(signal.label).toBe('SHORT_SQUEEZE');
    expect(signal.direction).toBe('bearish');
  });

  it('returns NEW_SHORTS for price down + OI up', () => {
    const signal = interpretOIDivergence(-1.5, 2.0);
    expect(signal.label).toBe('NEW_SHORTS');
    expect(signal.direction).toBe('bearish');
  });

  it('returns LONG_CAPITULATION for price down + OI down', () => {
    const signal = interpretOIDivergence(-2.0, -3.0);
    expect(signal.label).toBe('LONG_CAPITULATION');
    expect(signal.direction).toBe('bullish');
  });

  it('returns NEUTRAL for small changes', () => {
    const signal = interpretOIDivergence(0.1, 0.2);
    expect(signal.label).toBe('NEUTRAL');
  });
});

describe('interpretOBI', () => {
  it('returns BID_HEAVY for imbalance > 20%', () => {
    const signal = interpretOBI(25);
    expect(signal.label).toBe('BID_HEAVY');
    expect(signal.direction).toBe('bullish');
  });

  it('returns ASK_HEAVY for imbalance < -20%', () => {
    const signal = interpretOBI(-30);
    expect(signal.label).toBe('ASK_HEAVY');
    expect(signal.direction).toBe('bearish');
  });

  it('returns BALANCED for small imbalance', () => {
    const signal = interpretOBI(5);
    expect(signal.label).toBe('BALANCED');
    expect(signal.direction).toBe('neutral');
  });

  it('returns EXTREME_BID for imbalance > 40%', () => {
    const signal = interpretOBI(45);
    expect(signal.label).toBe('EXTREME_BID');
    expect(signal.direction).toBe('bullish');
  });

  it('returns EXTREME_ASK for imbalance < -40%', () => {
    const signal = interpretOBI(-50);
    expect(signal.label).toBe('EXTREME_ASK');
    expect(signal.direction).toBe('bearish');
  });
});
