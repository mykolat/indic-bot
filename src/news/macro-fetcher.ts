import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { insertMacroSnapshot } from '../db/repository.js';

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

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export class MacroFetcher {
  async fetch(): Promise<MacroSnapshot[]> {
    const results = await Promise.allSettled(
      SYMBOLS.map(s => this.fetchSymbol(s.symbol, s.name)),
    );

    const snapshots: MacroSnapshot[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) snapshots.push(r.value);
    }

    if (snapshots.length > 0) {
      const find = (sym: string) => snapshots.find(s => s.symbol === sym);
      insertMacroSnapshot({
        wti:    find('CL=F')?.price,
        dxy:    find('DX-Y.NYB')?.price,
        sp500:  find('^GSPC')?.price,
        vix:    find('^VIX')?.price,
        eurusd: find('EURUSD=X')?.price,
        gold:   find('GC=F')?.price,
      }).catch(() => {});
    }

    return snapshots;
  }

  private async fetchSymbol(symbol: string, name: string): Promise<MacroSnapshot | null> {
    try {
      const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const res = await fetchWithTimeout(url, {}, 10_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error('No result in Yahoo response');

      const meta = result.meta;
      const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
      const weekStart = closes.find((c: number | null) => c != null) ?? meta.regularMarketPrice;
      const weekChangeRaw = weekStart ? ((meta.regularMarketPrice - weekStart) / weekStart) * 100 : 0;

      return {
        symbol,
        name,
        price: parseFloat(meta.regularMarketPrice ?? 0),
        change24h: parseFloat(meta.regularMarketChangePercent ?? 0),
        changeWeek: parseFloat(weekChangeRaw.toFixed(2)),
        dayHigh: parseFloat(meta.regularMarketDayHigh ?? 0),
        dayLow: parseFloat(meta.regularMarketDayLow ?? 0),
      };
    } catch (err) {
      console.error(`[MacroFetcher] ${symbol} error:`, (err as Error).message);
      return null;
    }
  }

  async fetchBTCDominance(): Promise<{ dominance: number } | null> {
    try {
      const r = await fetchWithTimeout('https://api.coingecko.com/api/v3/global', {}, 10_000);
      if (!r.ok) return null;
      const data = await r.json() as any;
      return { dominance: data.data?.market_cap_percentage?.btc ?? 0 };
    } catch {
      return null;
    }
  }
}
