import { describe, it, expect } from 'vitest';
import { computeMemoryStats } from '../../src/memory/memory-stats.js';
import type { TradeRecord } from '../../src/memory/session.js';

describe('computeMemoryStats', () => {
  it('computes basic stats correctly', () => {
    const stats = computeMemoryStats([], 0);
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.bestPair).toBe('-');
    expect(stats.worstPair).toBe('-');
    expect(stats.currentStreak).toBe(0);
    expect(stats.avgWinPct).toBe(0);
    expect(stats.avgLossPct).toBe(0);
  });

  it('computes correct stats from trade history', () => {
    const trades: TradeRecord[] = [
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 5, pnlPct: 2.5, closedAt: '2026-03-04T10:00:00Z' },
      { pair: 'ETHUSDT', action: 'CLOSE', pnlUsd: -3, pnlPct: -1.5, closedAt: '2026-03-04T09:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 4, pnlPct: 2.0, closedAt: '2026-03-04T08:00:00Z' },
      { pair: 'SOLUSDT', action: 'CLOSE', pnlUsd: -2, pnlPct: -1.0, closedAt: '2026-03-04T07:00:00Z' },
      { pair: 'ETHUSDT', action: 'CLOSE', pnlUsd: 6, pnlPct: 3.0, closedAt: '2026-03-04T06:00:00Z' },
    ];

    const stats = computeMemoryStats(trades, 1.2);
    expect(stats.totalTrades).toBe(5);
    expect(stats.winRate).toBe(60);
    expect(stats.avgWinPct).toBeCloseTo(2.5);      // (2.5+2.0+3.0)/3
    expect(stats.avgLossPct).toBeCloseTo(-1.25);    // (-1.5+-1.0)/2
    expect(stats.profitFactor).toBeCloseTo(3.0);    // 15/5 total wins/losses
    expect(stats.currentStreak).toBe(1);            // last trade is a win
    expect(stats.sessionPnlPct).toBe(1.2);
    expect(stats.bestPair).toBe('BTCUSDT');         // +9.0 net (5+4)
    expect(stats.worstPair).toBe('SOLUSDT');        // -2.0 net
  });

  it('detects losing streaks', () => {
    const trades: TradeRecord[] = [
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: -1, pnlPct: -0.5, closedAt: '2026-03-04T12:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: -2, pnlPct: -1.0, closedAt: '2026-03-04T11:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: -3, pnlPct: -1.5, closedAt: '2026-03-04T10:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 1, pnlPct: 0.5, closedAt: '2026-03-04T09:00:00Z' },
    ];
    const stats = computeMemoryStats(trades, -2);
    expect(stats.currentStreak).toBe(-3);
  });
});
