import { describe, it, expect, vi } from 'vitest';
import { MacroFetcher } from '../../src/news/macro-fetcher.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../src/db/repository.js', () => ({ insertMacroSnapshot: vi.fn().mockResolvedValue(undefined) }));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

const makeYahooResponse = (symbol: string, price: number, change: number) => ({
  ok: true,
  json: async () => ({
    chart: {
      result: [{
        meta: {
          symbol,
          regularMarketPrice: price,
          regularMarketChangePercent: change,
          regularMarketDayHigh: price * 1.01,
          regularMarketDayLow: price * 0.99,
        },
        timestamp: [1700000000, 1700086400, 1700172800, 1700259200, 1700345600],
        indicators: { quote: [{ close: [price * 0.97, price * 0.98, price * 0.99, price * 0.999, price] }] },
      }],
      error: null,
    },
  }),
} as any);

describe('MacroFetcher (direct Yahoo Finance)', () => {
  it('fetches all symbols without Apify', async () => {
    mockFetch.mockResolvedValueOnce(makeYahooResponse('CL=F', 72.5, -0.3));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('DX-Y.NYB', 104.2, 0.1));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('^GSPC', 5800, 0.5));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('^VIX', 18.3, 2.1));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('EURUSD=X', 1.082, -0.05));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('GC=F', 2100, 0.2));

    const fetcher = new MacroFetcher();
    const result = await fetcher.fetch();

    expect(result).toHaveLength(6);
    expect(result[0].symbol).toBe('CL=F');
    expect(result[0].price).toBe(72.5);
    expect(result[0].change24h).toBeCloseTo(-0.3);
  });

  it('returns partial results on partial failure', async () => {
    mockFetch.mockResolvedValueOnce(makeYahooResponse('CL=F', 72.5, -0.3));
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('^GSPC', 5800, 0.5));
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const fetcher = new MacroFetcher();
    const result = await fetcher.fetch();

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('constructor takes no arguments (no apifyToken)', () => {
    expect(() => new MacroFetcher()).not.toThrow();
  });
});
