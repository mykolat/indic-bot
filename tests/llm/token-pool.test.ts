import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenPool } from '../../src/llm/token-pool.js';

vi.mock('../../src/db/repository.js', () => ({
  getActiveTokens: vi.fn(),
  updateTokenStats: vi.fn(),
  updateTokenError: vi.fn(),
}));

import { getActiveTokens, updateTokenStats, updateTokenError } from '../../src/db/repository.js';

const mockTokens = [
  { id: 1, label: 'alpha', provider: 'codex', auth_type: 'oauth', access_token: 'tok1', refresh_token: 'ref1', account_id: 'acc1', primary_used_pct: 20, secondary_used_pct: 40, is_active: true },
  { id: 2, label: 'bravo', provider: 'codex', auth_type: 'oauth', access_token: 'tok2', refresh_token: 'ref2', account_id: 'acc2', primary_used_pct: 80, secondary_used_pct: 10, is_active: true },
  { id: 3, label: 'charlie', provider: 'codex', auth_type: 'oauth', access_token: 'tok3', refresh_token: 'ref3', account_id: 'acc3', primary_used_pct: 95, secondary_used_pct: 96, is_active: true },
];

describe('TokenPool', () => {
  let pool: TokenPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new TokenPool();
  });

  it('getBestToken picks lowest secondary_used_pct within thresholds', async () => {
    (getActiveTokens as any).mockResolvedValue(mockTokens);
    const result = await pool.getBestToken('codex');
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2);
  });

  it('getBestToken skips tokens over threshold', async () => {
    (getActiveTokens as any).mockResolvedValue([mockTokens[2]]);
    const result = await pool.getBestToken('codex');
    expect(result).toBeNull();
  });

  it('getBestToken returns null on empty pool', async () => {
    (getActiveTokens as any).mockResolvedValue([]);
    const result = await pool.getBestToken('codex');
    expect(result).toBeNull();
  });

  it('parseRateLimitHeaders extracts x-codex-* headers', () => {
    const headers = new Map([
      ['x-codex-primary-used-percent', '45'],
      ['x-codex-secondary-used-percent', '72'],
      ['x-codex-primary-reset-at', '1773034096'],
      ['x-codex-secondary-reset-at', '1773436859'],
    ]);
    const stats = pool.parseRateLimitHeaders(headers);
    expect(stats.primary_used_pct).toBe(45);
    expect(stats.secondary_used_pct).toBe(72);
  });

  it('needsRotation returns true when primary > 80', () => {
    expect(pool.needsRotation({ primary_used_pct: 85, secondary_used_pct: 50 })).toBe(true);
  });

  it('needsRotation returns true when secondary > 85', () => {
    expect(pool.needsRotation({ primary_used_pct: 30, secondary_used_pct: 90 })).toBe(true);
  });

  it('needsRotation returns false when both below threshold', () => {
    expect(pool.needsRotation({ primary_used_pct: 30, secondary_used_pct: 50 })).toBe(false);
  });
});
