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
});
