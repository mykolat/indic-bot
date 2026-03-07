import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Watchdog } from '../src/watchdog.js';

describe('Watchdog', () => {
  let mockMarketData: any;
  let mockInsertSnapshot: any;
  let mockGetLatest: any;

  beforeEach(() => {
    mockMarketData = {
      getQuickSnapshot: vi.fn().mockResolvedValue({
        pair: 'BTCUSDT',
        markPrice: '70000',
        openInterest: '50000',
        fundingRate: '0.0001',
        orderBookBidPct: 55,
        orderBookAskPct: 45,
        longShortRatio: 1.2,
      }),
    };
    mockInsertSnapshot = vi.fn().mockResolvedValue(1);
    mockGetLatest = vi.fn().mockResolvedValue(null);
  });

  it('writes snapshot on first tick (no previous)', async () => {
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });
    await wd.tick();
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips write when nothing changed', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 70000,
      open_interest: 50000,
      funding_rate: 0.0001,
      long_short_ratio: 1.2,
      order_book_bid_pct: 55,
      order_book_ask_pct: 45,
    });
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });
    await wd.tick();
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it('writes when price changed', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 69500,
      open_interest: 50000,
      funding_rate: 0.0001,
    });
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });
    await wd.tick();
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('fires onAnomaly for price spike > 2%', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 68000,
      open_interest: 50000,
      funding_rate: 0.0001,
    });
    const onAnomaly = vi.fn();
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
      onAnomaly,
    });
    await wd.tick();
    expect(onAnomaly).toHaveBeenCalledWith('BTCUSDT', 'PRICE_SPIKE', expect.stringContaining('%'));
  });
});
