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

  describe('TP1 monitoring', () => {
    it('queues TP1 hit when LONG price crosses above TP', async () => {
      mockMarketData.getQuickSnapshot.mockResolvedValue({
        pair: 'BTCUSDT', markPrice: '72000', openInterest: '50000',
        fundingRate: '0.0001', orderBookBidPct: 55, orderBookAskPct: 45,
      });
      const wd = new Watchdog({
        pairs: ['BTCUSDT'], marketData: mockMarketData, sessionId: 's1',
        insertSnapshot: mockInsertSnapshot, getLatestSnapshot: mockGetLatest,
      });
      wd.setTp1Targets([{
        pair: 'BTCUSDT', side: 'LONG', entryPrice: 70000, tpPrice: 71500, executionId: 42,
      }]);
      await wd.tick();
      const hits = wd.drainTp1Hits();
      expect(hits).toHaveLength(1);
      expect(hits[0].pair).toBe('BTCUSDT');
      expect(hits[0].side).toBe('LONG');
      expect(hits[0].executionId).toBe(42);
    });

    it('queues TP1 hit when SHORT price crosses below TP', async () => {
      mockMarketData.getQuickSnapshot.mockResolvedValue({
        pair: 'ETHUSDT', markPrice: '3800', openInterest: '50000',
        fundingRate: '0.0001', orderBookBidPct: 55, orderBookAskPct: 45,
      });
      const wd = new Watchdog({
        pairs: ['ETHUSDT'], marketData: mockMarketData, sessionId: 's1',
        insertSnapshot: mockInsertSnapshot, getLatestSnapshot: mockGetLatest,
      });
      wd.setTp1Targets([{
        pair: 'ETHUSDT', side: 'SHORT', entryPrice: 4000, tpPrice: 3850, executionId: 43,
      }]);
      await wd.tick();
      const hits = wd.drainTp1Hits();
      expect(hits).toHaveLength(1);
      expect(hits[0].side).toBe('SHORT');
    });

    it('does not fire when price has not reached TP', async () => {
      const wd = new Watchdog({
        pairs: ['BTCUSDT'], marketData: mockMarketData, sessionId: 's1',
        insertSnapshot: mockInsertSnapshot, getLatestSnapshot: mockGetLatest,
      });
      wd.setTp1Targets([{
        pair: 'BTCUSDT', side: 'LONG', entryPrice: 70000, tpPrice: 75000, executionId: 44,
      }]);
      await wd.tick();
      expect(wd.drainTp1Hits()).toHaveLength(0);
    });

    it('fires only once (one-shot)', async () => {
      mockMarketData.getQuickSnapshot.mockResolvedValue({
        pair: 'BTCUSDT', markPrice: '76000', openInterest: '50000',
        fundingRate: '0.0001', orderBookBidPct: 55, orderBookAskPct: 45,
      });
      const wd = new Watchdog({
        pairs: ['BTCUSDT'], marketData: mockMarketData, sessionId: 's1',
        insertSnapshot: mockInsertSnapshot, getLatestSnapshot: mockGetLatest,
      });
      wd.setTp1Targets([{
        pair: 'BTCUSDT', side: 'LONG', entryPrice: 70000, tpPrice: 75000, executionId: 45,
      }]);
      await wd.tick();
      expect(wd.drainTp1Hits()).toHaveLength(1);
      await wd.tick();
      expect(wd.drainTp1Hits()).toHaveLength(0);
    });

    it('drainTp1Hits clears the queue', async () => {
      const wd = new Watchdog({
        pairs: ['BTCUSDT'], marketData: mockMarketData, sessionId: 's1',
        insertSnapshot: mockInsertSnapshot, getLatestSnapshot: mockGetLatest,
      });
      // Manually verify drain returns empty when no targets
      expect(wd.drainTp1Hits()).toHaveLength(0);
    });
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
