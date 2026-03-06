import { describe, it, expect } from 'vitest';
import { buildDiversityContext } from '../../src/market/pair-diversity.js';

describe('buildDiversityContext', () => {
  it('returns empty string when no history', () => {
    const result = buildDiversityContext([], ['BTCUSDT', 'ETHUSDT']);
    expect(result).toBe('');
  });

  it('shows cycles since last trade per pair', () => {
    const history = [
      { pair: 'BTCUSDT', cycle: 10 },
      { pair: 'BTCUSDT', cycle: 8 },
      { pair: 'ETHUSDT', cycle: 5 },
    ];
    const result = buildDiversityContext(history, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 12);
    expect(result).toContain('BTCUSDT: 2 cycles ago');
    expect(result).toContain('ETHUSDT: 7 cycles ago');
    expect(result).toContain('SOLUSDT: never traded');
  });

  it('adds concentration warning when >50% on one pair', () => {
    const history = [
      { pair: 'ADAUSDT', cycle: 10 },
      { pair: 'ADAUSDT', cycle: 9 },
      { pair: 'ADAUSDT', cycle: 8 },
      { pair: 'BTCUSDT', cycle: 7 },
    ];
    const result = buildDiversityContext(history, ['BTCUSDT', 'ADAUSDT'], 12);
    expect(result).toContain('WARNING');
    expect(result).toContain('ADAUSDT');
    expect(result).toContain('75%');
  });

  it('no warning when evenly distributed', () => {
    const history = [
      { pair: 'BTCUSDT', cycle: 10 },
      { pair: 'ETHUSDT', cycle: 9 },
      { pair: 'SOLUSDT', cycle: 8 },
    ];
    const result = buildDiversityContext(history, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 12);
    expect(result).not.toContain('WARNING');
  });
});
