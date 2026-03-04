import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketDataFetcher } from '../../src/binance/market-data.js';

describe('MarketDataFetcher', () => {
  let fetcher: MarketDataFetcher;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      getKlines: vi.fn().mockResolvedValue([
        [1704067200000, '42000', '42500', '41800', '42200', '100', 1704070800000, '4200000', 50, '60', '2520000', '0'],
        [1704070800000, '42200', '42800', '42100', '42600', '120', 1704074400000, '5100000', 60, '70', '2980000', '0'],
      ]),
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
    expect(mockClient.getKlines).toHaveBeenCalledTimes(2);
  });

  it('fetches portfolio state', async () => {
    const state = await fetcher.getPortfolioState();

    expect(state.balanceUsd).toBe(10);
    expect(state.positions).toHaveLength(0);
  });
});
