import { describe, it, expect } from 'vitest';
import { computeMACD, computeBollingerBands, computeVolumeRatio, computeVWAP, computeIndicators, computeADX, computeRSI } from '../../src/indicators/technical.js';

describe('computeRSI', () => {
  it('returns 50 when not enough data', () => {
    expect(computeRSI([100, 101])).toBe(50);
  });

  it('computes Wilder smoothing RSI correctly', () => {
    // A known monotonic increasing series
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = computeRSI(closes, 14);
    expect(rsi).toBe(100); // 100% gains
  });
});

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

  it('extrapolates volume when openTimes are provided', () => {
    const volumes = [...Array(20).fill(1000), 100]; // last volume is 100
    const now = Date.now();
    // 15 mins into the candle
    const openTimes = [...Array(20).fill(0), now - 15 * 60000];
    const ratio = computeVolumeRatio(volumes, openTimes);
    // 100 * (60/15) = 400. 400/1000 = 0.4
    expect(ratio).toBeCloseTo(0.4, 1);
  });

  it('uses previous volume if candle is younger than 10 mins', () => {
    const volumes = [...Array(20).fill(1000), 10]; // last volume is 10
    const now = Date.now();
    // 5 mins into the candle
    const openTimes = [...Array(20).fill(0), now - 5 * 60000];
    const ratio = computeVolumeRatio(volumes, openTimes);
    expect(ratio).toBeCloseTo(1.0, 1); // Uses previous volume (1000)
  });
});

describe('computeVWAP', () => {
  it('returns volume-weighted average price', () => {
    const highs = [105, 110, 108];
    const lows = [95, 90, 92];
    const closes = [100, 100, 100];
    const volumes = [1000, 2000, 1000];
    const vwap = computeVWAP(highs, lows, closes, volumes);
    expect(vwap).toBeGreaterThan(95);
    expect(vwap).toBeLessThan(110);
  });
});

describe('computeADX', () => {
  it('returns 0 when not enough data', () => {
    const highs = [105, 110];
    const lows = [95, 90];
    const closes = [100, 100];
    expect(computeADX(highs, lows, closes)).toBe(0);
  });

  it('returns high ADX (>25) for monotonically trending data', () => {
    const n = 35;
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 2);
    const highs = closes.map(c => c + 1);
    const lows = closes.map(c => c - 1);
    const adx = computeADX(highs, lows, closes);
    expect(adx).toBeGreaterThan(25);
  });

  it('returns low ADX (<25) for oscillating/ranging data', () => {
    const n = 35;
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 0.8) * 3);
    const highs = closes.map(c => c + 1.5);
    const lows = closes.map(c => c - 1.5);
    const adx = computeADX(highs, lows, closes);
    expect(adx).toBeLessThan(25);
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
    expect(result).toHaveProperty('adx');
    expect(typeof result.adx).toBe('number');
  });
});
