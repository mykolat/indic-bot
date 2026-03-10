import { describe, it, expect } from 'vitest';
import { buildWatchdogSummary } from '../src/watchdog-summary.js';

describe('buildWatchdogSummary', () => {
  it('summarizes price movement and SL status', () => {
    const snapshots = [
      { mark_price: 70000, open_interest: 50000, created_at: new Date(Date.now() - 600000).toISOString() },
      { mark_price: 70200, open_interest: 50500, created_at: new Date(Date.now() - 300000).toISOString() },
      { mark_price: 70350, open_interest: 51000, created_at: new Date().toISOString() },
    ];
    const positionCtx = { sl_price: 69000, tp_price: 73000, fill_price: 70000, side: 'BUY' };

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, positionCtx as any);

    expect(summary).toContain('BTCUSDT');
    expect(summary).toContain('+0.5%');
    expect(summary).toContain('SL $69000 NOT hit');
    expect(summary).toContain('OI');
  });

  it('returns minimal summary when no snapshots', () => {
    const summary = buildWatchdogSummary('BTCUSDT', [], undefined);
    expect(summary).toContain('no data');
  });

  it('shows SL HIT when price below stop for LONG', () => {
    const snapshots = [
      { mark_price: 70000, open_interest: 50000, created_at: new Date(Date.now() - 60000).toISOString() },
      { mark_price: 68500, open_interest: 50000, created_at: new Date().toISOString() },
    ];
    const positionCtx = { sl_price: 69000, tp_price: 73000, fill_price: 70000, side: 'BUY' };

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, positionCtx as any);
    expect(summary).toContain('SL');
    expect(summary).toContain('HIT');
  });

  it('includes funding rate and L/S ratio in summary', () => {
    const snaps = [
      { mark_price: 70000, open_interest: 50000, funding_rate: 0.0001, long_short_ratio: 1.2, created_at: '2026-03-06T10:00:00Z' },
      { mark_price: 70500, open_interest: 51000, funding_rate: 0.0003, long_short_ratio: 1.5, created_at: '2026-03-06T10:10:00Z' },
    ] as any;
    const result = buildWatchdogSummary('BTCUSDT', snaps, undefined);
    expect(result).toContain('Funding');
    expect(result).toContain('L/S');
  });

  it('flags funding rate sign flip', () => {
    const snaps = [
      { mark_price: 70000, open_interest: 50000, funding_rate: 0.0001, long_short_ratio: 1.0, created_at: '2026-03-06T10:00:00Z' },
      { mark_price: 70100, open_interest: 50000, funding_rate: -0.0002, long_short_ratio: 0.8, created_at: '2026-03-06T10:10:00Z' },
    ] as any;
    const result = buildWatchdogSummary('BTCUSDT', snaps, undefined);
    expect(result).toContain('Funding flipped');
    expect(result).toContain('L/S 1.00→0.80');
  });

  it('includes order book imbalance in summary', () => {
    const snapshots = [
      { mark_price: 70000, open_interest: 50000, imbalance_pct: 5, created_at: new Date(Date.now() - 60000).toISOString() },
      { mark_price: 70100, open_interest: 50000, imbalance_pct: 15, created_at: new Date().toISOString() },
    ];
    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
    expect(summary).toContain('OBI +15%');
  });

  it('shows negative OBI for ask-heavy book', () => {
    const snapshots = [
      { mark_price: 70000, open_interest: 50000, imbalance_pct: -20, created_at: new Date(Date.now() - 60000).toISOString() },
      { mark_price: 69800, open_interest: 50000, imbalance_pct: -25, created_at: new Date().toISOString() },
    ];
    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
    expect(summary).toContain('OBI -25%');
  });

  it('omits OBI when imbalance_pct is null', () => {
    const snapshots = [
      { mark_price: 70000, open_interest: 50000, created_at: new Date(Date.now() - 60000).toISOString() },
      { mark_price: 70100, open_interest: 50000, created_at: new Date().toISOString() },
    ];
    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
    expect(summary).not.toContain('OBI');
  });

  // --- NaN guards for zero/null values (PEPE bug) ---

  it('handles zero mark_price without NaN', () => {
    const snapshots = [
      { pair: 'PEPEUSDT', mark_price: 0, open_interest: 1000000, created_at: '2026-03-10T09:00:00Z' },
      { pair: 'PEPEUSDT', mark_price: 0.0000085, open_interest: 1000000, created_at: '2026-03-10T09:10:00Z' },
    ];
    const result = buildWatchdogSummary('PEPEUSDT', snapshots as any, undefined);
    expect(result).not.toContain('NaN');
  });

  it('handles both mark_prices being zero without NaN', () => {
    const snapshots = [
      { pair: 'PEPEUSDT', mark_price: 0, open_interest: 1000000, created_at: '2026-03-10T09:00:00Z' },
      { pair: 'PEPEUSDT', mark_price: 0, open_interest: 1000000, created_at: '2026-03-10T09:10:00Z' },
    ];
    const result = buildWatchdogSummary('PEPEUSDT', snapshots as any, undefined);
    expect(result).not.toContain('NaN');
  });

  it('handles zero open_interest without NaN', () => {
    const snapshots = [
      { pair: 'PEPEUSDT', mark_price: 0.0000085, open_interest: 0, created_at: '2026-03-10T09:00:00Z' },
      { pair: 'PEPEUSDT', mark_price: 0.0000090, open_interest: 500000, created_at: '2026-03-10T09:10:00Z' },
    ];
    const result = buildWatchdogSummary('PEPEUSDT', snapshots as any, undefined);
    expect(result).not.toContain('NaN');
  });

  it('handles null/undefined imbalance_pct without NaN', () => {
    const snapshots = [
      { pair: 'PEPEUSDT', mark_price: 0.0000085, open_interest: 1000000, imbalance_pct: undefined, created_at: '2026-03-10T09:00:00Z' },
      { pair: 'PEPEUSDT', mark_price: 0.0000090, open_interest: 1000000, imbalance_pct: undefined, created_at: '2026-03-10T09:10:00Z' },
    ];
    const result = buildWatchdogSummary('PEPEUSDT', snapshots as any, undefined);
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('OBI');
  });

  it('computes correct price delta for normal snapshots', () => {
    const snapshots = [
      { pair: 'BTCUSDT', mark_price: 69000, open_interest: 50000, created_at: '2026-03-10T09:00:00Z' },
      { pair: 'BTCUSDT', mark_price: 69690, open_interest: 50000, created_at: '2026-03-10T09:10:00Z' },
    ];
    const result = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
    expect(result).toContain('+1.0%');
  });
});
