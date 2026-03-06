import { describe, it, expect } from 'vitest';
import { buildSwarmFingerprint, hasChanged } from '../../src/llm/swarm-fingerprint.js';

describe('swarm-fingerprint', () => {
  const base = {
    positions: [{ pair: 'ADAUSDT', side: 'SHORT', unrealizedPnlPct: -2.1 }],
    regime: 'BearTrend',
    volumeRatio: 1.8,
    fearGreedValue: 35,
  };

  it('produces stable fingerprint for same inputs', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint(base);
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
  });

  it('detects change when position added', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({
      ...base,
      positions: [...base.positions, { pair: 'BTCUSDT', side: 'LONG', unrealizedPnlPct: 1.0 }],
    });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });

  it('detects change when regime changes', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({ ...base, regime: 'Breakout' });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });

  it('ignores small PnL drift (<1%)', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({
      ...base,
      positions: [{ pair: 'ADAUSDT', side: 'SHORT', unrealizedPnlPct: -2.5 }],
    });
    expect(hasChanged(fp1, fp2)).toBe(false);
  });

  it('detects large PnL change (>2%)', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({
      ...base,
      positions: [{ pair: 'ADAUSDT', side: 'SHORT', unrealizedPnlPct: -5.0 }],
    });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });

  it('detects fear/greed bucket change', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({ ...base, fearGreedValue: 15 });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });
});
