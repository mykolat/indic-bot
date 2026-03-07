import { describe, it, expect } from 'vitest';
import { detectGhostPositions } from '../src/position-reconciler.js';

describe('detectGhostPositions', () => {
  it('returns empty when DB and Binance match', () => {
    const dbOpen = [{ id: 1, pair: 'BTCUSDT', side: 'BUY' }];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'LONG' as const }];
    expect(detectGhostPositions(dbOpen, binancePositions)).toEqual([]);
  });

  it('detects ghost when DB has position but Binance does not', () => {
    const dbOpen = [
      { id: 1, pair: 'BTCUSDT', side: 'BUY' },
      { id: 2, pair: 'ETHUSDT', side: 'SELL' },
    ];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'LONG' as const }];
    const ghosts = detectGhostPositions(dbOpen, binancePositions);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].pair).toBe('ETHUSDT');
  });

  it('ignores Binance positions not in DB', () => {
    const dbOpen: any[] = [];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'LONG' as const }];
    expect(detectGhostPositions(dbOpen, binancePositions)).toEqual([]);
  });

  it('handles multiple ghosts', () => {
    const dbOpen = [
      { id: 1, pair: 'BTCUSDT', side: 'BUY' },
      { id: 2, pair: 'ETHUSDT', side: 'SELL' },
      { id: 3, pair: 'SOLUSDT', side: 'BUY' },
    ];
    const binancePositions: any[] = [];
    expect(detectGhostPositions(dbOpen, binancePositions)).toHaveLength(3);
  });

  it('matches SHORT side correctly', () => {
    const dbOpen = [{ id: 1, pair: 'BTCUSDT', side: 'SELL' }];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'SHORT' as const }];
    expect(detectGhostPositions(dbOpen, binancePositions)).toEqual([]);
  });
});
