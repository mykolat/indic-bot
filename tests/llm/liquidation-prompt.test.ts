import { describe, it, expect } from 'vitest';
import { formatLiquidationBlock } from '../../src/llm/prompts.js';
import type { DbLiquidation } from '../../src/db/types.js';

describe('formatLiquidationBlock', () => {
  it('returns empty string when no liquidations', () => {
    expect(formatLiquidationBlock([])).toBe('');
  });

  it('formats liquidation data with LONG SQUEEZE label', () => {
    const liqs: DbLiquidation[] = [{
      pair: 'BTCUSDT',
      long_liquidations: 500,
      short_liquidations: 50,
      long_liq_usd: 2500000,
      short_liq_usd: 400000,
      spike_ratio: 3.2,
    }];
    const result = formatLiquidationBlock(liqs);
    expect(result).toContain('## Recent Liquidations (last 15min)');
    expect(result).toContain('$2.5M long liquidated');
    expect(result).toContain('$400K short liquidated');
    expect(result).toContain('spike 3.2x');
    expect(result).toContain('LONG SQUEEZE');
  });

  it('labels SHORT SQUEEZE when shorts dominate', () => {
    const liqs: DbLiquidation[] = [{
      pair: 'ETHUSDT',
      long_liquidations: 30,
      short_liquidations: 300,
      long_liq_usd: 300000,
      short_liq_usd: 3000000,
      spike_ratio: 2.1,
    }];
    const result = formatLiquidationBlock(liqs);
    expect(result).toContain('SHORT SQUEEZE');
    expect(result).toContain('$3.0M short liquidated');
    expect(result).toContain('$300K long liquidated');
  });

  it('labels MIXED when balanced', () => {
    const liqs: DbLiquidation[] = [{
      pair: 'BTCUSDT',
      long_liquidations: 100,
      short_liquidations: 80,
      long_liq_usd: 1000000,
      short_liq_usd: 800000,
      spike_ratio: 1.5,
    }];
    const result = formatLiquidationBlock(liqs);
    expect(result).toContain('MIXED');
  });

  it('groups multiple entries for same pair', () => {
    const liqs: DbLiquidation[] = [
      { pair: 'BTCUSDT', long_liquidations: 10, short_liquidations: 5, long_liq_usd: 500000, short_liq_usd: 100000, spike_ratio: 2.0 },
      { pair: 'BTCUSDT', long_liquidations: 20, short_liquidations: 10, long_liq_usd: 2000000, short_liq_usd: 200000, spike_ratio: 3.0 },
    ];
    const result = formatLiquidationBlock(liqs);
    expect(result).toContain('$2.5M long liquidated');
    expect(result).toContain('$300K short liquidated');
    expect(result).toContain('spike 3.0x');
    expect(result).toContain('LONG SQUEEZE');
    // Should only have one BTCUSDT line
    const lines = result.split('\n').filter(l => l.includes('BTCUSDT'));
    expect(lines).toHaveLength(1);
  });
});
