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
  { symbol: 'CL=F', name: 'WTI Crude Oil' },
  { symbol: 'DX-Y.NYB', name: 'DXY Dollar Index' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^VIX', name: 'VIX Fear Index' },
  { symbol: 'EURUSD=X', name: 'EUR/USD' },
  { symbol: 'GC=F', name: 'Gold' },
];

const ACTOR_ID = 'vaclavrut~stock-price-yahoo-finance';

export class MacroFetcher {
  constructor(private apifyToken: string) { }

  async fetch(): Promise<MacroSnapshot[]> {
    try {
      const tickers = SYMBOLS.map(s => s.symbol);
      let datasetId: string | undefined;

      // Fetch the latest successful run (Actors are scheduled externally)
      const runsUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${this.apifyToken}&desc=true&limit=5`;
      const runsRes = await fetchWithTimeout(runsUrl, {}, 10_000).catch(() => null);

      if (runsRes && runsRes.ok) {
        const runsData = (await runsRes.json()) as any;
        const recentRuns = runsData.data?.items || [];
        const lastSuccess = recentRuns.find((r: any) => r.status === 'SUCCEEDED');

        if (lastSuccess) {
          console.log(`[MacroFetcher] Using dataset from scheduled run: ${lastSuccess.id}`);
          datasetId = lastSuccess.defaultDatasetId;
        }
      }

      if (!datasetId) {
        throw new Error(`No successful runs found for actor ${ACTOR_ID}`);
      }

      const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${this.apifyToken}`;
      const datasetRes = await fetchWithTimeout(datasetUrl, {}, 15_000);
      if (!datasetRes.ok) throw new Error(`Failed to fetch macro dataset ${datasetId}`);
      const items = await datasetRes.json() as any[];

      const snapshots = items.map((item: any) => {
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

      // Save to DB
      const wti = snapshots.find(s => s.symbol === 'CL=F');
      const dxy = snapshots.find(s => s.symbol === 'DX-Y.NYB');
      const sp500 = snapshots.find(s => s.symbol === '^GSPC');
      const vix = snapshots.find(s => s.symbol === '^VIX');
      const eurusd = snapshots.find(s => s.symbol === 'EURUSD=X');
      const gold = snapshots.find(s => s.symbol === 'GC=F');
      insertMacroSnapshot({
        wti: wti?.price, dxy: dxy?.price, sp500: sp500?.price,
        vix: vix?.price, eurusd: eurusd?.price, gold: gold?.price,
      }).catch(() => {});

      return snapshots;
    } catch (err) {
      console.error('[MacroFetcher] Error:', err);
      return [];
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
