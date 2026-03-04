import type { PortfolioState, Position } from '../risk/manager.js';

export interface CandleData {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface FundingRatePoint {
  rate: number;
  time: number;  // unix ms
}

export interface MarketSnapshot {
  pair: string;
  candles1h: CandleData[];
  candles4h: CandleData[];
  candles15m: CandleData[];
  fundingRate: string;
  fundingHistory: FundingRatePoint[];
  openInterest: string;
  markPrice: string;
  openInterestDelta?: number;
}

export class MarketDataFetcher {
  constructor(private client: any) {}

  async getSnapshot(pair: string): Promise<MarketSnapshot> {
    const [candles1h, candles4h, candles15m, markPrice, oi, fundingHist] = await Promise.all([
      this.client.getKlines({ symbol: pair, interval: '1h', limit: 50 }),
      this.client.getKlines({ symbol: pair, interval: '4h', limit: 50 }),
      this.client.getKlines({ symbol: pair, interval: '15m', limit: 50 }),
      this.client.getMarkPrice({ symbol: pair }),
      this.client.getOpenInterest({ symbol: pair }),
      this.client.getFundingRateHistory({ symbol: pair, limit: 8 }).catch(() => []),
    ]);

    return {
      pair,
      candles1h: this.parseCandles(candles1h),
      candles4h: this.parseCandles(candles4h),
      candles15m: this.parseCandles(candles15m),
      fundingRate: markPrice.lastFundingRate,
      fundingHistory: (fundingHist as any[]).map(f => ({
        rate: parseFloat(f.fundingRate),
        time: f.fundingTime,
      })),
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
      .map((p: any) => {
        const notional = Math.abs(parseFloat(p.notional));
        const leverage = parseInt(p.leverage, 10);
        const margin = notional / leverage;
        const unrealizedProfit = parseFloat(p.unRealizedProfit || p.unrealizedProfit || '0');
        const unrealizedPnlPct = margin > 0 ? (unrealizedProfit / margin) * 100 : 0;
        const updateTime = parseInt(p.updateTime || '0', 10);
        const heldHours = updateTime > 0
          ? (Date.now() - updateTime) / 3_600_000
          : 0;

        return {
          pair: p.symbol,
          sizeUsd: notional,
          leverage,
          side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
          entryPrice: parseFloat(p.entryPrice || '0'),
          unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
          heldHours: parseFloat(heldHours.toFixed(1)),
        };
      });

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
