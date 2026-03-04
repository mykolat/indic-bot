import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketDataFetcher } from '../../src/binance/market-data.js';

const FAKE_CANDLE = [1704067200000, '42000', '42500', '41800', '42200', '100', 1704070800000, '4200000', 50, '60', '2520000', '0'];

describe('MarketDataFetcher', () => {
  let fetcher: MarketDataFetcher;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      getKlines: vi.fn().mockResolvedValue([FAKE_CANDLE, FAKE_CANDLE]),
      getMarkPrice: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT',
        markPrice: '42500.00',
        lastFundingRate: '0.0001',
        nextFundingTime: 1704096000000,
      }),
      getOpenInterest: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT',
        openInterest: '80000.00',
      }),
      getFundingRateHistory: vi.fn().mockResolvedValue([
        { fundingRate: '0.0001', fundingTime: 1000 },
        { fundingRate: '0.0002', fundingTime: 2000 },
      ]),
      getPositions: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '10.00', availableBalance: '10.00' },
      ]),
    };
    fetcher = new MarketDataFetcher(mockClient);
  });

  it('fetches a complete market snapshot for a pair', async () => {
    const snapshot = await fetcher.getSnapshot('BTCUSDT');

    expect(snapshot.pair).toBe('BTCUSDT');
    expect(snapshot.candles1h).toHaveLength(2);
    expect(snapshot.fundingRate).toBe('0.0001');
    expect(snapshot.openInterest).toBe('80000.00');
    // 1h + 4h + 15m = 3 getKlines calls
    expect(mockClient.getKlines).toHaveBeenCalledTimes(3);
  });

  it('fetches portfolio state', async () => {
    const state = await fetcher.getPortfolioState();

    expect(state.balanceUsd).toBe(10);
    expect(state.positions).toHaveLength(0);
  });

  it('getSnapshot includes candles15m and fundingHistory', async () => {
    const snapshot = await fetcher.getSnapshot('BTCUSDT');

    expect(snapshot.candles15m).toBeDefined();
    expect(snapshot.candles15m.length).toBeGreaterThan(0);
    expect(snapshot.fundingHistory).toBeDefined();
    expect(snapshot.fundingHistory.length).toBe(2);
    expect(snapshot.fundingHistory[0].rate).toBeCloseTo(0.0001);
  });
});
