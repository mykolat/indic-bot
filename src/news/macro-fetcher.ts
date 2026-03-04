export interface MacroSnapshot {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  changeWeek: number;
  dayHigh: number;
  dayLow: number;
}

const SYMBOLS = [
  { symbol: 'CL=F',      name: 'WTI Crude Oil' },
  { symbol: 'DX-Y.NYB',  name: 'DXY Dollar Index' },
  { symbol: '^GSPC',     name: 'S&P 500' },
  { symbol: '^VIX',      name: 'VIX Fear Index' },
  { symbol: 'EURUSD=X',  name: 'EUR/USD' },
  { symbol: 'GC=F',      name: 'Gold' },
];

const ACTOR_ID = 'vaclavrut~stock-price-yahoo-finance';

export class MacroFetcher {
  constructor(private apifyToken: string) {}

  async fetch(): Promise<MacroSnapshot[]> {
    try {
      const tickers = SYMBOLS.map(s => s.symbol);
      const response = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${this.apifyToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickers }),
        }
      );

      if (!response.ok) throw new Error(`Apify macro ${response.status}`);

      const items = await response.json() as any[];

      return items.map((item: any) => {
        const sym = SYMBOLS.find(s => s.symbol === item.ticker || s.symbol === item.symbol);
        return {
          symbol: item.ticker ?? item.symbol,
          name: sym?.name ?? item.shortName ?? item.ticker,
          price: parseFloat(item.regularMarketPrice ?? item.price ?? 0),
          change24h: parseFloat(item.regularMarketChangePercent ?? item.changePercent ?? 0),
          changeWeek: parseFloat(item.fiftyTwoWeekChangePercent ?? item.weekChangePercent ?? 0),
          dayHigh: parseFloat(item.regularMarketDayHigh ?? item.dayHigh ?? 0),
          dayLow: parseFloat(item.regularMarketDayLow ?? item.dayLow ?? 0),
        };
      });
    } catch (err) {
      console.error('[MacroFetcher] Error:', err);
      return [];
    }
  }

  async fetchBTCDominance(): Promise<{ dominance: number } | null> {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/global');
      if (!r.ok) return null;
      const data = await r.json() as any;
      return { dominance: data.data?.market_cap_percentage?.btc ?? 0 };
    } catch {
      return null;
    }
  }
}
