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
      getTopTradersLongShortPositionRatio: vi.fn().mockResolvedValue([
        { longShortRatio: '1.23', longAccount: '0.55', shortAccount: '0.45', timestamp: 1000 },
      ]),
      getOrderBook: vi.fn().mockResolvedValue({
        bids: [['100', '5'], ['99', '10'], ['98', '8'], ['97', '3'], ['96', '2']],
        asks: [['101', '3'], ['102', '6'], ['103', '4'], ['104', '2'], ['105', '1']],
      }),
      getPositions: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '10.00', availableBalance: '10.00' },
      ]),
      getAccountInformation: vi.fn().mockResolvedValue({
        totalMarginBalance: '10',
        totalUnrealizedProfit: '0',
      }),
    };
    fetcher = new MarketDataFetcher(mockClient);
  });

  it('fetches a complete market snapshot for a pair', async () => {
    const snapshot = await fetcher.getSnapshot('BTCUSDT');

    expect(snapshot.pair).toBe('BTCUSDT');
    expect(snapshot.candles1h).toHaveLength(2);
    expect(snapshot.fundingRate).toBe('0.0001');
    expect(snapshot.openInterest).toBe('80000.00');
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

  it('getSnapshot includes longShortRatio and orderBookImbalance', async () => {
    const snapshot = await fetcher.getSnapshot('BTCUSDT');

    expect(snapshot.longShortRatio).toBeCloseTo(1.23);
    expect(snapshot.orderBookBidPct).toBeGreaterThan(0);
    expect(snapshot.orderBookAskPct).toBeGreaterThan(0);
    expect(snapshot.orderBookBidPct + snapshot.orderBookAskPct).toBeCloseTo(100, 0);
  });
});

describe('MarketDataFetcher.getQuickSnapshot', () => {
  it('fetches only price, OI, funding, lsRatio, orderBook — no candles', async () => {
    const mockClient = {
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: '70000' }),
      getOpenInterest: vi.fn().mockResolvedValue({ openInterest: '50000' }),
      getFundingRateHistory: vi.fn().mockResolvedValue([{ fundingRate: '0.0001', fundingTime: Date.now() }]),
      getTopTradersLongShortAccountRatio: vi.fn().mockResolvedValue([{ longShortRatio: '1.2' }]),
      getOrderBook: vi.fn().mockResolvedValue({
        bids: [['70000', '10']],
        asks: [['70100', '8']],
      }),
      getKlines: vi.fn(),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const snap = await fetcher.getQuickSnapshot('BTCUSDT');

    expect(snap.pair).toBe('BTCUSDT');
    expect(snap.markPrice).toBe('70000');
    expect(snap.openInterest).toBe('50000');
    expect(snap.fundingRate).toBe('0.0001');
    expect(snap.longShortRatio).toBeCloseTo(1.2);
    expect(snap.orderBookBidPct).toBeGreaterThan(50); // 10 vs 8
    expect(mockClient.getKlines).not.toHaveBeenCalled();
  });

  it('handles API failures gracefully with defaults', async () => {
    const mockClient = {
      getMarkPrice: vi.fn().mockRejectedValue(new Error('timeout')),
      getOpenInterest: vi.fn().mockRejectedValue(new Error('timeout')),
      getFundingRateHistory: vi.fn().mockRejectedValue(new Error('timeout')),
      getTopTradersLongShortAccountRatio: vi.fn().mockRejectedValue(new Error('timeout')),
      getOrderBook: vi.fn().mockRejectedValue(new Error('timeout')),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const snap = await fetcher.getQuickSnapshot('BTCUSDT');

    expect(snap.markPrice).toBe('0');
    expect(snap.openInterest).toBe('0');
    expect(snap.longShortRatio).toBeNull();
    expect(snap.orderBookBidPct).toBe(50);
  });
});

describe('getPortfolioState extended fields', () => {
  it('includes marginUsd and unrealizedPnlUsd per position', async () => {
    const mockClient = {
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '1000', availableBalance: '800' },
      ]),
      getPositions: vi.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', positionAmt: '0.01', notional: '500', leverage: '10', entryPrice: '50000', unRealizedProfit: '25', updateTime: String(Date.now() - 3600000) },
      ]),
      getAccountInformation: vi.fn().mockResolvedValue({
        totalMarginBalance: '1050',
        totalUnrealizedProfit: '25',
      }),
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: '0' }),
    };
    const fetcher = new MarketDataFetcher(mockClient);
    const state = await fetcher.getPortfolioState();

    expect(state.marginBalanceUsd).toBe(1050);
    expect(state.totalUnrealizedPnlUsd).toBe(25);
    expect(state.positions[0].marginUsd).toBeDefined();
    expect(state.positions[0].unrealizedPnlUsd).toBe(25);
  });

  it('includes bnbBalance', async () => {
    const mockClient = {
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '1000', availableBalance: '800' },
        { asset: 'BNB', balance: '0.5', availableBalance: '0.5' },
      ]),
      getPositions: vi.fn().mockResolvedValue([]),
      getAccountInformation: vi.fn().mockResolvedValue({ totalMarginBalance: '1000', totalUnrealizedProfit: '0' }),
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: '600' }),
    };
    const fetcher = new MarketDataFetcher(mockClient);
    const state = await fetcher.getPortfolioState();

    expect(state.bnbBalance).toBe(0.5);
    expect(state.totalAccountValueUsd).toBeGreaterThan(1000);
  });
});

describe('getTodayRealizedPnl', () => {
  it('sums today realized PnL from income', async () => {
    const mockClient = {
      getIncome: vi.fn().mockResolvedValue([
        { income: '15.5' },
        { income: '-3.2' },
        { income: '8.0' },
      ]),
    };
    const fetcher = new MarketDataFetcher(mockClient);
    const pnl = await fetcher.getTodayRealizedPnl();
    expect(pnl).toBeCloseTo(20.3, 1);
  });

  it('returns 0 on error', async () => {
    const mockClient = {
      getIncome: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const fetcher = new MarketDataFetcher(mockClient);
    const pnl = await fetcher.getTodayRealizedPnl();
    expect(pnl).toBe(0);
  });
});
