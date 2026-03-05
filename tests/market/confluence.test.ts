import { describe, it, expect } from 'vitest';
import { computeConfluence, type ConfluenceInput } from '../../src/market/confluence.js';

describe('computeConfluence', () => {
  const baseInput: ConfluenceInput = {
    trend: 'neutral',
    volumeRatio: 0.5,
    vwap: 100,
    markPrice: 100,
    rsi: 25,
    rsiRange: [30, 70],
    hasNewsCatalyst: false,
  };

  it('returns 0 when no factors align', () => {
    const result = computeConfluence(baseInput);
    expect(result.score).toBe(0);
    expect(result.factors).toHaveLength(0);
  });

  it('counts trend alignment as factor', () => {
    const result = computeConfluence({ ...baseInput, trend: 'bullish' });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('trend');
  });

  it('counts volume > 1x as factor', () => {
    const result = computeConfluence({ ...baseInput, volumeRatio: 1.5 });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('volume');
  });

  it('counts VWAP alignment for bullish trend', () => {
    const result = computeConfluence({
      ...baseInput,
      trend: 'bullish',
      markPrice: 105,
      vwap: 100,
    });
    expect(result.score).toBe(2);
    expect(result.factors).toContain('vwap');
  });

  it('counts VWAP alignment for bearish trend', () => {
    const result = computeConfluence({
      ...baseInput,
      trend: 'bearish',
      markPrice: 95,
      vwap: 100,
    });
    expect(result.score).toBe(2);
    expect(result.factors).toContain('vwap');
  });

  it('does NOT count VWAP when price contradicts trend', () => {
    const result = computeConfluence({
      ...baseInput,
      trend: 'bullish',
      markPrice: 95,
      vwap: 100,
    });
    expect(result.score).toBe(1);
    expect(result.factors).not.toContain('vwap');
  });

  it('counts RSI in range as factor', () => {
    const result = computeConfluence({
      ...baseInput,
      rsi: 55,
      rsiRange: [45, 80],
    });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('rsi');
  });

  it('does NOT count RSI outside range', () => {
    const result = computeConfluence({
      ...baseInput,
      rsi: 85,
      rsiRange: [45, 80],
    });
    expect(result.score).toBe(0);
    expect(result.factors).not.toContain('rsi');
  });

  it('counts news catalyst as factor', () => {
    const result = computeConfluence({ ...baseInput, hasNewsCatalyst: true });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('news');
  });

  it('returns max 5 when all factors align', () => {
    const result = computeConfluence({
      trend: 'bullish',
      volumeRatio: 2.0,
      vwap: 100,
      markPrice: 105,
      rsi: 55,
      rsiRange: [45, 80],
      hasNewsCatalyst: true,
    });
    expect(result.score).toBe(5);
    expect(result.factors).toHaveLength(5);
  });
});
