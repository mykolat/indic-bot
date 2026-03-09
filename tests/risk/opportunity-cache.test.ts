import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpportunityCache, type CandidateEpisode } from '../../src/risk/opportunity-cache.js';

describe('OpportunityCache', () => {
  let cache: OpportunityCache;

  beforeEach(() => {
    cache = new OpportunityCache();
  });

  it('caches a new candidate episode', () => {
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 65, price: 8.50,
    });
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached).toBeDefined();
    expect(cached!.entryScore).toBe(65);
  });

  it('returns undefined for unknown episode', () => {
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached).toBeUndefined();
  });

  it('updates existing episode on re-add', () => {
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 65, price: 8.50,
    });
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 70, price: 8.45,
    });
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached!.entryScore).toBe(70);
  });

  it('expires episodes after TTL', () => {
    vi.useFakeTimers();
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 65, price: 8.50, ttlMs: 60_000,
    });
    vi.advanceTimersByTime(61_000);
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached).toBeUndefined();
    vi.useRealTimers();
  });

  it('returns all active candidates sorted by score', () => {
    cache.add({ pair: 'LINKUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 65, price: 8.50 });
    cache.add({ pair: 'DOGEUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 72, price: 0.15 });
    cache.add({ pair: 'APTUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 55, price: 5.0 });

    const all = cache.getActiveCandidates();
    expect(all).toHaveLength(3);
    expect(all[0].pair).toBe('DOGEUSDT');  // highest score first
    expect(all[2].pair).toBe('APTUSDT');   // lowest score last
  });

  it('invalidates on regime change', () => {
    cache.add({ pair: 'LINKUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 65, price: 8.50 });
    cache.invalidateByRegime('BullTrend');
    const cached = cache.get('LINKUSDT', 'SHORT', 'tc', 'BearTrend');
    expect(cached).toBeUndefined();
  });
});
