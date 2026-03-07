import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { getOpenPositionContexts } from '../../src/db/repository.js';

describe('getOpenPositionContexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty pairs', async () => {
    const result = await getOpenPositionContexts([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns position contexts for given pairs', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        pair: 'BTCUSDT',
        side: 'BUY',
        fill_price: 70000,
        sl_price: 68600,
        tp_price: 73500,
        entry_thesis: 'Bullish breakout',
        leverage: 5,
        size_usd: 500,
        opened_at: new Date().toISOString(),
      }],
    });

    const result = await getOpenPositionContexts(['BTCUSDT', 'ETHUSDT']);

    expect(result).toHaveLength(1);
    expect(result[0].pair).toBe('BTCUSDT');
    expect(result[0].sl_price).toBe(68600);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('DISTINCT ON');
    expect(sql).toContain('LEFT JOIN trade_closes');
    expect(sql).toContain('48 hours');
    expect(sql).toContain('fill_price IS NOT NULL');
  });

  it('passes pairs as parameterized query', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await getOpenPositionContexts(['BTCUSDT', 'ETHUSDT']);
    expect(mockQuery.mock.calls[0][1]).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(mockQuery.mock.calls[0][0]).toContain('$1');
    expect(mockQuery.mock.calls[0][0]).toContain('$2');
  });
});
