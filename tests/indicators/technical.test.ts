import { describe, it, expect } from 'vitest';
import { computeMACD, computeBollingerBands, computeVolumeRatio, computeVWAP, computeIndicators } from '../../src/indicators/technical.js';

describe('computeMACD', () => {
  it('returns macd, signal, histogram', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const result = computeMACD(closes);
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('histogram');
    expect(typeof result.macd).toBe('number');
  });

  it('returns zeros when not enough data', () => {
    const result = computeMACD([100, 101]);
    expect(result).toEqual({ macd: 0, signal: 0, histogram: 0 });
  });
});

describe('computeBollingerBands', () => {
  it('returns upper, middle, lower bands', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
    const result = computeBollingerBands(closes);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
    expect(typeof result.bandwidth).toBe('number');
    expect(typeof result.percentB).toBe('number');
  });
});

describe('computeVolumeRatio', () => {
  it('returns ratio > 1 when last volume is high', () => {
    const volumes = [...Array(20).fill(1000), 3000];
    expect(computeVolumeRatio(volumes)).toBeGreaterThan(1);
  });

  it('returns 1 when only one candle', () => {
    expect(computeVolumeRatio([500])).toBe(1);
  });
});

describe('computeVWAP', () => {
  it('returns volume-weighted average price', () => {
    const highs =   [105, 110, 108];
    const lows =    [95,  90,  92];
    const closes =  [100, 100, 100];
    const volumes = [1000, 2000, 1000];
    const vwap = computeVWAP(highs, lows, closes, volumes);
    expect(vwap).toBeGreaterThan(95);
    expect(vwap).toBeLessThan(110);
  });
});

describe('computeIndicators with volumes', () => {
  it('includes macd, bollinger, volumeRatio, vwap in output', () => {
    const n = 60;
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.3);
    const highs = closes.map(c => c + 2);
    const lows = closes.map(c => c - 2);
    const volumes = Array.from({ length: n }, () => 1000 + Math.random() * 500);
    const result = computeIndicators(closes, highs, lows, volumes);
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('bollingerUpper');
    expect(result).toHaveProperty('bollingerLower');
    expect(result).toHaveProperty('volumeRatio');
    expect(result).toHaveProperty('vwap');
  });
});
