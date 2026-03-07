import { describe, it, expect } from 'vitest';
import { computeAllowedSlRange } from '../../src/risk/sl-tightening-rules.js';

describe('computeAllowedSlRange', () => {
  describe('SHORT positions', () => {
    it('at +2% profit, no tightening allowed (SL stays at entry or above)', () => {
      const range = computeAllowedSlRange({
        side: 'SHORT',
        entryPrice: 100,
        currentPrice: 98,
        atrPct: 1.5,
      });
      expect(range.maxSlPrice).toBeGreaterThanOrEqual(100);
      expect(range.tier).toContain('no_tightening');
    });

    it('at +7% profit, allows breakeven (SL at entry)', () => {
      const range = computeAllowedSlRange({
        side: 'SHORT',
        entryPrice: 100,
        currentPrice: 93,
        atrPct: 1.5,
      });
      // For SHORT, maxSlPrice = entry (breakeven) but respecting ATR distance
      expect(range.maxSlPrice).toBeLessThanOrEqual(100);
      expect(range.tier).toContain('breakeven');
    });

    it('at +15% profit, locks 40% of profit', () => {
      const range = computeAllowedSlRange({
        side: 'SHORT',
        entryPrice: 100,
        currentPrice: 85,
        atrPct: 1.5,
      });
      // 40% of 15 = 6 locked → SL at 94 (entry - 6)
      expect(range.tier).toContain('lock_40pct');
      expect(range.maxSlPrice).toBeLessThan(100); // In profit zone
      expect(range.maxSlPrice).toBeGreaterThan(85); // Above current price
    });

    it('at +25% profit, locks 60% of profit', () => {
      const range = computeAllowedSlRange({
        side: 'SHORT',
        entryPrice: 100,
        currentPrice: 75,
        atrPct: 1.5,
      });
      // 60% of 25 = 15 locked → SL at 85 (entry - 15)
      expect(range.tier).toContain('lock_60pct');
      expect(range.maxSlPrice).toBeLessThan(100);
      expect(range.maxSlPrice).toBeGreaterThan(75);
    });
  });

  describe('LONG positions', () => {
    it('at +2% profit, no tightening', () => {
      const range = computeAllowedSlRange({
        side: 'LONG',
        entryPrice: 100,
        currentPrice: 102,
        atrPct: 1.5,
      });
      expect(range.maxSlPrice).toBeLessThanOrEqual(100);
      expect(range.tier).toContain('no_tightening');
    });

    it('at +20% profit, locks 60%', () => {
      const range = computeAllowedSlRange({
        side: 'LONG',
        entryPrice: 100,
        currentPrice: 120,
        atrPct: 2.0,
      });
      // 60% of 20 = 12 locked → SL at 112 (entry + 12)
      expect(range.tier).toContain('lock_60pct');
      expect(range.maxSlPrice).toBeGreaterThan(100);
      expect(range.maxSlPrice).toBeLessThan(120);
    });
  });

  describe('ATR distance enforcement', () => {
    it('SL must be at least 1.5x ATR from current price', () => {
      const range = computeAllowedSlRange({
        side: 'LONG',
        entryPrice: 100,
        currentPrice: 120,
        atrPct: 2.0,
      });
      // Min distance = 120 * (2.0 * 1.5) / 100 = 3.6
      const distanceFromPrice = 120 - range.maxSlPrice;
      expect(distanceFromPrice).toBeGreaterThanOrEqual(3.5);
    });

    it('ATR can override profit tier if more conservative', () => {
      // High ATR = volatile → SL stays further
      const range = computeAllowedSlRange({
        side: 'SHORT',
        entryPrice: 100,
        currentPrice: 75,
        atrPct: 5.0, // Very volatile
      });
      // ATR distance from current: 75 * 5 * 1.5 / 100 = 5.625
      // So maxSlPrice >= 75 + 5.625 = 80.625
      expect(range.maxSlPrice).toBeGreaterThanOrEqual(80);
    });
  });
});
