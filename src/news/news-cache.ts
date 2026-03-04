import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { CryptoNews } from './types.js';
import { NewsDB, type NewsRow } from './news-db.js';

export interface NewsSignal {
  coins: string[];
  direction: 'bullish' | 'bearish' | 'neutral';
  importance: number;
  timeframe: 'short' | 'medium' | 'long';
  catalyst: string;
  reasoning: string;
  price_impact: 'high' | 'medium' | 'low';
  expires_hours: number;
  source_count: number;
  conflicting: boolean;
}

export interface NewsAnalysis {
  market_summary: string;
  top_signals: NewsSignal[];
  overall_sentiment: string;
  macro_signals: {
    fed_stance: string;
    risk_appetite: string;
    dominance_trend: string;
  };
  risk_events: string[];
}

export interface NewsCacheState {
  items: CryptoNews[];
  fetchedAt: string;
  analysis: NewsAnalysis | null;
  analyzedAt: string | null;
}

export class NewsCache {
  private _db: NewsDB | null = null;

  private get dir() { return join(process.env.HOME || '.', '.indic-bot'); }
  private get cacheFile() { return join(this.dir, 'news-cache.json'); }
  private get historyFile() { return join(this.dir, 'news-history.jsonl'); }
  private get dbPath() { return join(this.dir, 'news.db'); }

  private get db(): NewsDB {
    if (!this._db) this._db = new NewsDB(this.dbPath);
    return this._db;
  }

  load(): NewsCacheState | null {
    try {
      return JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as NewsCacheState;
    } catch {
      return null;
    }
  }

  save(state: NewsCacheState): void {
    mkdirSync(this.dir, { recursive: true });
    // Insert items into SQLite (dedup on title+date)
    if (state.items?.length) this.db.insert(state.items);
    // Persist metadata only — items live in SQLite now
    writeFileSync(this.cacheFile, JSON.stringify({
      fetchedAt: state.fetchedAt,
      analysis: state.analysis,
      analyzedAt: state.analyzedAt,
      items: [],
    }, null, 2), 'utf-8');
  }

  shouldRefresh(intervalHours: number): boolean {
    const state = this.load();
    if (!state) return true;
    const ageMs = Date.now() - new Date(state.fetchedAt).getTime();
    return ageMs > intervalHours * 3_600_000;
  }

  getAnalysis(): NewsAnalysis | null {
    return this.load()?.analysis ?? null;
  }

  getRecentItems(hours = 48): NewsRow[] {
    return this.db.getRecent(hours);
  }

  dbCount(): number {
    return this.db.count();
  }

  appendHistory(state: NewsCacheState): void {
    mkdirSync(this.dir, { recursive: true });
    const record = {
      fetchedAt: state.fetchedAt,
      analyzedAt: state.analyzedAt,
      itemCount: state.items.length,
      analysis: state.analysis,
      items: state.items,
    };
    appendFileSync(this.historyFile, JSON.stringify(record) + '\n', 'utf-8');
  }
}
