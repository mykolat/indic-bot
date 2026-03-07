import { describe, it, expect } from 'vitest';
import { computeMarketReaction } from '../../src/news/market-reaction.js';
import type { DbMarketSnapshot } from '../../src/db/types.js';

function makeSnapshot(overrides: Partial<DbMarketSnapshot> & { created_at: string }): DbMarketSnapshot {
  return {
    pair: 'BTCUSDT',
    mark_price: 60000,
    open_interest: 1_000_000,
    funding_rate: 0.0001,
    imbalance_pct: 5,
    ...overrides,
  };
}

describe('computeMarketReaction', () => {
  const eventTime = '2026-03-07T12:00:00Z';

  it('returns IGNORES when price displacement < 0.5%', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T11:55:00Z', mark_price: 60000 }),
      makeSnapshot({ created_at: '2026-03-07T12:05:00Z', mark_price: 60100 }), // +0.17%
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bullish');

    expect(result.verdict).toBe('IGNORES');
    expect(Math.abs(result.priceDisplacementPct)).toBeLessThan(0.5);
  });

  it('returns CONFIRMS when price moves in same direction as bullish claim with OI expansion', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({
        created_at: '2026-03-07T11:55:00Z',
        mark_price: 60000,
        open_interest: 1_000_000,
        imbalance_pct: 5,
      }),
      makeSnapshot({
        created_at: '2026-03-07T12:05:00Z',
        mark_price: 61000, // +1.67%
        open_interest: 1_100_000, // +10%
        imbalance_pct: 15,
      }),
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bullish');

    expect(result.verdict).toBe('CONFIRMS');
    expect(result.priceDisplacementPct).toBeGreaterThan(0);
    expect(result.oiChangePct).toBeGreaterThan(0);
    expect(result.summary).toContain('CONFIRMS');
  });

  it('returns FADES when price moves opposite to bullish claim', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({
        created_at: '2026-03-07T11:55:00Z',
        mark_price: 60000,
      }),
      makeSnapshot({
        created_at: '2026-03-07T12:05:00Z',
        mark_price: 59000, // -1.67%
      }),
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bullish');

    expect(result.verdict).toBe('FADES');
    expect(result.priceDisplacementPct).toBeLessThan(0);
    expect(result.summary).toContain('FADES');
  });

  it('returns IGNORES when no snapshots after event', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T11:55:00Z', mark_price: 60000 }),
      makeSnapshot({ created_at: '2026-03-07T11:58:00Z', mark_price: 60500 }),
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bullish');

    expect(result.verdict).toBe('IGNORES');
    expect(result.priceDisplacementPct).toBe(0);
    expect(result.oiChangePct).toBe(0);
  });

  it('detects funding flip (sign change in funding_rate)', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({
        created_at: '2026-03-07T11:55:00Z',
        mark_price: 60000,
        funding_rate: 0.0005,
      }),
      makeSnapshot({
        created_at: '2026-03-07T12:05:00Z',
        mark_price: 61000, // +1.67% so not IGNORES
        funding_rate: -0.0003,
      }),
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bullish');

    expect(result.fundingFlipped).toBe(true);
    expect(result.summary).toContain('funding flipped');
  });

  it('returns CONFIRMS for any significant move when claimDirection is neutral', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T11:55:00Z', mark_price: 60000 }),
      makeSnapshot({ created_at: '2026-03-07T12:05:00Z', mark_price: 59000 }), // -1.67%
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'neutral');

    expect(result.verdict).toBe('CONFIRMS');
  });

  it('returns CONFIRMS for any significant move when no claimDirection', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T11:55:00Z', mark_price: 60000 }),
      makeSnapshot({ created_at: '2026-03-07T12:05:00Z', mark_price: 61500 }), // +2.5%
    ];

    const result = computeMarketReaction(snapshots, eventTime);

    expect(result.verdict).toBe('CONFIRMS');
  });

  it('returns FADES when price moves opposite to bearish claim (price goes up)', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T11:55:00Z', mark_price: 60000 }),
      makeSnapshot({ created_at: '2026-03-07T12:05:00Z', mark_price: 61000 }), // +1.67%
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bearish');

    expect(result.verdict).toBe('FADES');
  });

  it('returns CONFIRMS when price drops on bearish claim', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T11:55:00Z', mark_price: 60000 }),
      makeSnapshot({ created_at: '2026-03-07T12:05:00Z', mark_price: 59000 }), // -1.67%
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bearish');

    expect(result.verdict).toBe('CONFIRMS');
  });

  it('returns IGNORES when no snapshots before event', () => {
    const snapshots: DbMarketSnapshot[] = [
      makeSnapshot({ created_at: '2026-03-07T12:05:00Z', mark_price: 61000 }),
    ];

    const result = computeMarketReaction(snapshots, eventTime, 'bullish');

    expect(result.verdict).toBe('IGNORES');
    expect(result.priceDisplacementPct).toBe(0);
  });
});
