import type { MarketDataFetcher, QuickSnapshot } from './binance/market-data.js';
import type { DbMarketSnapshot } from './db/types.js';

export interface WatchdogDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  sessionId: string;
  insertSnapshot: (s: Omit<DbMarketSnapshot, 'id' | 'created_at'>) => Promise<number>;
  getLatestSnapshot: (pair: string) => Promise<DbMarketSnapshot | null>;
  onAnomaly?: (pair: string, type: string, detail: string) => void;
}

export class Watchdog {
  private deps: WatchdogDeps;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WatchdogDeps) {
    this.deps = deps;
  }

  start(intervalMs = 60_000): void {
    console.log(`[Watchdog] Starting — ${this.deps.pairs.length} pairs, every ${intervalMs / 1000}s`);
    this.intervalId = setInterval(() => this.tick().catch(e => console.error('[Watchdog] tick error:', e.message)), intervalMs);
    this.tick().catch(e => console.error('[Watchdog] initial tick error:', e.message));
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(): Promise<void> {
    const results = await Promise.allSettled(
      this.deps.pairs.map(pair => this.processPair(pair)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[Watchdog] pair tick failed:', r.reason);
      }
    }
  }

  private async processPair(pair: string): Promise<void> {
    const snap = await this.deps.marketData.getQuickSnapshot(pair);
    const prev = await this.deps.getLatestSnapshot(pair);
    const current = this.extractFields(snap);

    if (prev && !this.hasChanged(prev, current)) {
      return;
    }

    await this.deps.insertSnapshot({
      session_id: this.deps.sessionId,
      ...current,
    });

    if (prev && this.deps.onAnomaly) {
      const priceDelta = Math.abs(current.mark_price - Number(prev.mark_price)) / Number(prev.mark_price) * 100;
      if (priceDelta > 2) {
        this.deps.onAnomaly(pair, 'PRICE_SPIKE', `${priceDelta.toFixed(1)}% in 1 min`);
      }
      if (prev.open_interest && current.open_interest) {
        const oiDelta = Math.abs(current.open_interest - Number(prev.open_interest)) / Number(prev.open_interest) * 100;
        if (oiDelta > 10) {
          this.deps.onAnomaly(pair, 'OI_SPIKE', `${oiDelta.toFixed(1)}% change`);
        }
      }
    }
  }

  private extractFields(snap: QuickSnapshot): Omit<DbMarketSnapshot, 'id' | 'created_at' | 'session_id'> {
    return {
      pair: snap.pair,
      mark_price: parseFloat(snap.markPrice),
      open_interest: parseFloat(snap.openInterest),
      funding_rate: parseFloat(snap.fundingRate),
      long_short_ratio: snap.longShortRatio ?? undefined,
      order_book_bid_pct: snap.orderBookBidPct,
      order_book_ask_pct: snap.orderBookAskPct,
      imbalance_pct: snap.imbalancePct,
    };
  }

  private hasChanged(prev: DbMarketSnapshot, current: Omit<DbMarketSnapshot, 'id' | 'created_at' | 'session_id'>): boolean {
    if (Number(prev.mark_price) !== current.mark_price) return true;
    if (Number(prev.open_interest) !== current.open_interest) return true;
    if (Number(prev.funding_rate) !== current.funding_rate) return true;
    if (Number(prev.long_short_ratio) !== current.long_short_ratio) return true;
    if (Number(prev.order_book_bid_pct) !== current.order_book_bid_pct) return true;
    return false;
  }
}
