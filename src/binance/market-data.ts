import type { PortfolioState, Position } from '../risk/manager.js';

export interface CandleData {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface MarketSnapshot {
  pair: string;
  candles1h: CandleData[];
  candles4h: CandleData[];
  fundingRate: string;
  openInterest: string;
  markPrice: string;
}

export class MarketDataFetcher {
  constructor(private client: any) {}

  async getSnapshot(pair: string): Promise<MarketSnapshot> {
    const [candles1h, candles4h, markPrice, oi] = await Promise.all([
      this.client.getKlines({ symbol: pair, interval: '1h', limit: 20 }),
      this.client.getKlines({ symbol: pair, interval: '4h', limit: 20 }),
      this.client.getMarkPrice({ symbol: pair }),
      this.client.getOpenInterest({ symbol: pair }),
    ]);

    return {
      pair,
      candles1h: this.parseCandles(candles1h),
      candles4h: this.parseCandles(candles4h),
      fundingRate: markPrice.lastFundingRate,
      openInterest: oi.openInterest,
      markPrice: markPrice.markPrice,
    };
  }

  async getPortfolioState(): Promise<PortfolioState> {
    const [balances, positions] = await Promise.all([
      this.client.getBalance(),
      this.client.getPositions(),
    ]);

    const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
    const balanceUsd = usdtBalance ? parseFloat(usdtBalance.availableBalance) : 0;

    const openPositions: Position[] = positions
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => ({
        pair: p.symbol,
        sizeUsd: Math.abs(parseFloat(p.notional)),
        leverage: parseInt(p.leverage, 10),
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
      }));

    return {
      balanceUsd,
      positions: openPositions,
      sessionPnl: 0,
    };
  }

  private parseCandles(raw: any[]): CandleData[] {
    return raw.map((c: any) => ({
      openTime: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
  }
}
