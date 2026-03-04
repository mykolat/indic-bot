# News Accumulation + Macro Intelligence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SQLite news accumulation (permanent, 48h window for LLM), macro market tracking via Apify (oil/DXY/VIX/S&P500/gold, every 3h), time-aware prompts (news age + current UTC session), token usage logging, and a smarter system prompt that tells LLM exactly what we trade and watch.

**Architecture:** Four new files (`news-db.ts`, `macro-fetcher.ts`, `macro-analyst.ts`, `token-logger.ts`), four modified files (`news-cache.ts`, `client.ts`, `prompts.ts`, `trading-loop.ts`), `scripts/audit.ts` gets TOKEN USAGE section. SQLite via `better-sqlite3` (sync API, no async). All existing tests must pass after each task.

**Tech Stack:** TypeScript ESM, `better-sqlite3`, Apify REST API (existing token), Vitest for tests.

---

### Task 1: Install better-sqlite3 and create NewsDB

**Files:**
- Modify: `package.json`
- Create: `src/news/news-db.ts`
- Create: `tests/news/news-db.test.ts`

**Step 1: Install better-sqlite3**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

Expected: `package.json` updated. Run `npm ls better-sqlite3` → shows version.

**Step 2: Write the failing test**

Create `tests/news/news-db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NewsDB } from '../../src/news/news-db.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DIR = '/tmp/indic-test-newsdb';
const TEST_DB = join(TEST_DIR, 'news.db');

describe('NewsDB', () => {
  let db: NewsDB;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new NewsDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('inserts news items and retrieves them', () => {
    db.insert([
      { title: 'BTC hits $73K', date: new Date().toISOString(), coins: ['BTC'], sentiment: 1, source: 'coindesk' },
    ]);
    const recent = db.getRecent(48);
    expect(recent).toHaveLength(1);
    expect(recent[0].title).toBe('BTC hits $73K');
    expect(recent[0].age_hours).toBeGreaterThanOrEqual(0);
    expect(recent[0].age_hours).toBeLessThan(1);
  });

  it('deduplicates on title+date', () => {
    const item = { title: 'BTC hits $73K', date: '2026-03-04T10:00:00Z', coins: ['BTC'], sentiment: 1, source: 'coindesk' };
    db.insert([item]);
    db.insert([item]); // second insert same item
    expect(db.count()).toBe(1);
  });

  it('getRecent excludes items older than hours param', () => {
    const old = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    db.insert([{ title: 'Old news', date: old, coins: [], sentiment: 0, source: 'x' }]);
    expect(db.getRecent(48)).toHaveLength(0);
  });

  it('count returns total rows', () => {
    db.insert([
      { title: 'A', date: new Date().toISOString(), coins: [], sentiment: 0, source: 'x' },
      { title: 'B', date: new Date().toISOString(), coins: [], sentiment: 0, source: 'x' },
    ]);
    expect(db.count()).toBe(2);
  });
});
```

**Step 3: Run test to verify it fails**

```bash
npx vitest run tests/news/news-db.test.ts
```

Expected: FAIL with "Cannot find module '../../src/news/news-db.js'"

**Step 4: Implement `src/news/news-db.ts`**

```typescript
import Database from 'better-sqlite3';
import type { CryptoNews } from './types.js';

export interface NewsRow extends CryptoNews {
  age_hours: number;
}

export class NewsDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        coins TEXT NOT NULL,
        sentiment REAL NOT NULL,
        source TEXT NOT NULL,
        UNIQUE(title, date)
      )
    `);
  }

  insert(items: CryptoNews[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO news (title, date, coins, sentiment, source) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = this.db.transaction((rows: CryptoNews[]) => {
      for (const row of rows) {
        stmt.run(row.title, row.date, JSON.stringify(row.coins), row.sentiment, row.source);
      }
    });
    insertMany(items);
  }

  getRecent(hours: number): NewsRow[] {
    const rows = this.db.prepare(`
      SELECT title, date, coins, sentiment, source,
        (julianday('now') - julianday(date)) * 24 AS age_hours
      FROM news
      WHERE date > datetime('now', '-' || ? || ' hours')
      ORDER BY date DESC
    `).all(hours) as any[];

    return rows.map(r => ({
      title: r.title,
      date: r.date,
      coins: JSON.parse(r.coins),
      sentiment: r.sentiment,
      source: r.source,
      age_hours: r.age_hours,
    }));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM news').get() as any).n;
  }

  close(): void {
    this.db.close();
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/news/news-db.test.ts
```

Expected: 4 tests PASS.

**Step 6: Run all tests to check nothing broke**

```bash
npx vitest run tests/
```

Expected: all 67 tests PASS.

**Step 7: Commit**

```bash
git add src/news/news-db.ts tests/news/news-db.test.ts package.json package-lock.json
git commit -m "feat: add NewsDB — SQLite news accumulation with dedup"
```

---

### Task 2: Wire NewsDB into news-cache.ts and trading-loop

**Files:**
- Modify: `src/news/news-cache.ts`
- Modify: `src/trading-loop.ts`

**Context:** Currently `NewsCache` stores items in `news-cache.json`. We keep that file for `analysis` + `fetchedAt`, but items now live in SQLite. `NewsDB` path: `~/.indic-bot/news.db`.

**Step 1: Update `src/news/news-cache.ts`**

Add `NewsDB` integration. `NewsCacheState` no longer needs to store items (only analysis metadata):

```typescript
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { CryptoNews } from './types.js';
import { NewsDB } from './news-db.js';

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
  items: CryptoNews[];  // kept for history append
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
    // Insert items into SQLite
    if (state.items?.length) this.db.insert(state.items);
    // Save metadata (analysis, fetchedAt) to JSON — items field kept for appendHistory
    writeFileSync(this.cacheFile, JSON.stringify({
      fetchedAt: state.fetchedAt,
      analysis: state.analysis,
      analyzedAt: state.analyzedAt,
      items: [],  // don't persist items in JSON anymore
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

  getRecentItems(hours = 48): import('./news-db.js').NewsRow[] {
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
    };
    appendFileSync(this.historyFile, JSON.stringify(record) + '\n', 'utf-8');
  }
}
```

**Step 2: Run all tests**

```bash
npx vitest run tests/
```

Expected: all PASS (trading-loop.test uses mocked newsCache).

**Step 3: Commit**

```bash
git add src/news/news-cache.ts
git commit -m "feat: wire NewsDB into NewsCache — SQLite for item storage"
```

---

### Task 3: Time-aware prompts (news age + current UTC session)

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `tests/llm/client.test.ts` (update snapshot if needed)

**Context:** `buildEnrichedPrompt` in `prompts.ts` needs:
1. `currentTime` string injected at top of prompt
2. News formatted with `[Xh ago]` prefix using `age_hours`
3. System prompt updated to mention trading pairs and macro assets tracked

**Step 1: Add `getTradingSession` helper and `currentTime` to prompts**

In `src/llm/prompts.ts`, add before `buildEnrichedPrompt`:

```typescript
function getTradingSession(utcHour: number): string {
  const inAsia = utcHour >= 0 && utcHour < 8;
  const inEurope = utcHour >= 7 && utcHour < 16;
  const inUS = utcHour >= 13 && utcHour < 22;

  if (utcHour >= 13 && utcHour < 16) return 'EU/US overlap (high liquidity)';
  if (utcHour >= 7 && utcHour < 8) return 'Asia close / EU open overlap';
  if (inAsia) return 'Asia session';
  if (inEurope) return 'European session';
  if (inUS) return 'US session';
  return 'Off-hours (low liquidity)';
}

function formatCurrentTime(): string {
  const now = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const day = days[now.getUTCDay()];
  const h = now.getUTCHours().toString().padStart(2, '0');
  const m = now.getUTCMinutes().toString().padStart(2, '0');
  const session = getTradingSession(now.getUTCHours());
  return `${now.toISOString().slice(0,10)} ${h}:${m} UTC (${day}) — ${session}`;
}
```

**Step 2: Update `EnrichedPromptData` interface** to add `recentNewsWithAge` and `macroAnalysis`:

```typescript
export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
  indicators4h?: Map<string, Indicators>;
  portfolio: PortfolioState;
  signals: TradingViewSignal[];
  news: CryptoNews[];
  fearGreed: FearGreedData;
  sessionNotes?: string;
  recentTrades?: TradeRecord[];
  newsAnalysis?: import('../news/news-cache.js').NewsAnalysis;
  recentNewsWithAge?: Array<CryptoNews & { age_hours: number }>; // NEW
  macroAnalysis?: MacroAnalysis; // NEW — defined in Task 4
}
```

**Step 3: Update `buildEnrichedPrompt` to inject time and aged news**

At the very top of the function, before `## Technical Analysis`:

```typescript
function buildEnrichedPrompt(data: EnrichedPromptData): string {
  let prompt = `## Context\nCurrent time: ${formatCurrentTime()}\n\n`;

  // ... existing technical analysis section unchanged ...

  // Replace the news section (around line 174) with:
  if (data.recentNewsWithAge && data.recentNewsWithAge.length > 0) {
    prompt += '## News (last 48h)\n';
    if (data.newsAnalysis) {
      const na = data.newsAnalysis;
      prompt += `Sentiment: ${na.overall_sentiment} | fed=${na.macro_signals.fed_stance}, risk=${na.macro_signals.risk_appetite}\n`;
      prompt += `Summary: ${na.market_summary}\n`;
      if (na.top_signals.length > 0) {
        prompt += 'Key signals:\n';
        for (const s of na.top_signals.sort((a, b) => b.importance - a.importance).slice(0, 10)) {
          const coins = s.coins.join('/');
          prompt += `  [${s.importance}/10] ${coins} ${s.direction.toUpperCase()} (${s.timeframe}) — ${s.catalyst}\n`;
        }
      }
      if (na.risk_events.length > 0) {
        prompt += `Risk: ${na.risk_events.slice(0, 3).join(' | ')}\n`;
      }
    }
    prompt += '\nHeadlines:\n';
    for (const n of data.recentNewsWithAge.slice(0, 30)) {
      const age = Math.round(n.age_hours);
      const coins = n.coins.length > 0 ? `[${n.coins.join('/')}] ` : '';
      const sent = n.sentiment > 0 ? '▲' : n.sentiment < 0 ? '▼' : '─';
      prompt += `  [${age}h ago] ${coins}${sent} ${n.title}\n`;
    }
    prompt += '\n';
  } else if (data.newsAnalysis) {
    // fallback: analysis only, no raw items
    const na = data.newsAnalysis;
    prompt += '## News Analysis\n';
    prompt += `Sentiment: ${na.overall_sentiment} | fed=${na.macro_signals.fed_stance}, risk=${na.macro_signals.risk_appetite}\n`;
    prompt += `Summary: ${na.market_summary}\n`;
    if (na.top_signals.length > 0) {
      prompt += 'Signals:\n';
      for (const s of na.top_signals.sort((a, b) => b.importance - a.importance).slice(0, 8)) {
        prompt += `  [${s.importance}/10] ${s.coins.join('/')} ${s.direction.toUpperCase()} — ${s.catalyst}\n`;
      }
    }
    prompt += '\n';
  }
  // ... rest unchanged ...
}
```

**Step 4: Update system prompt to mention context**

In `buildSystemPrompt`, after the first line, add:

```typescript
return `You are an aggressive crypto futures trader managing a live account.
Trading pairs: ${config.pairs?.join(', ') ?? 'BTCUSDT, ETHUSDT, SOLUSDT'}
Monitoring macro: Oil (WTI), DXY, S&P500, VIX, EUR/USD, Gold, BTC Dominance
Target: +${config.targetReturnPct}% returns.
// ... rest unchanged
```

Update `buildSystemPrompt` signature to accept optional `pairs`:

```typescript
export function buildSystemPrompt(config: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
  pairs?: string[];
}): string {
```

**Step 5: Run all tests**

```bash
npx vitest run tests/
```

Expected: all PASS. If `client.test.ts` snapshot breaks, update the test's `makePromptData` or mock to not check prompt content strictly.

**Step 6: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: time-aware prompts — current UTC session + news age in hours"
```

---

### Task 4: MacroFetcher + MacroAnalystAgent

**Files:**
- Create: `src/news/macro-fetcher.ts`
- Create: `src/news/macro-analyst.ts`
- Create: `tests/news/macro-analyst.test.ts`

**Step 1: Write the failing test**

Create `tests/news/macro-analyst.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MacroAnalystAgent } from '../../src/news/macro-analyst.js';

describe('MacroAnalystAgent', () => {
  it('parses valid macro analysis from LLM response', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        macro_summary: 'DXY strengthening, risk-off environment.',
        risk_environment: 'risk_off',
        crypto_correlation_signal: 'bearish',
        key_levels: ['DXY 104 resistance', 'VIX 20 threshold'],
        refreshed_at: '2026-03-04T19:00:00Z',
      })),
    };

    const agent = new MacroAnalystAgent(mockLlm);
    const result = await agent.analyze([
      { symbol: 'DXY', name: 'DXY Index', price: 104.2, change24h: 0.8, changeWeek: 1.2, dayHigh: 104.5, dayLow: 103.8 },
    ]);

    expect(result.risk_environment).toBe('risk_off');
    expect(result.crypto_correlation_signal).toBe('bearish');
    expect(result.key_levels).toHaveLength(2);
  });

  it('returns fallback on LLM error', async () => {
    const mockLlm = { call: vi.fn().mockRejectedValue(new Error('timeout')) };
    const agent = new MacroAnalystAgent(mockLlm);
    const result = await agent.analyze([]);
    expect(result.risk_environment).toBe('neutral');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/news/macro-analyst.test.ts
```

Expected: FAIL with "Cannot find module"

**Step 3: Create `src/news/macro-fetcher.ts`**

```typescript
export interface MacroSnapshot {
  symbol: string;
  name: string;
  price: number;
  change24h: number;   // percent
  changeWeek: number;  // percent
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

// Apify actor for Yahoo Finance quotes
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

  async fetchBTCDominance(): Promise<{ dominance: number; change24h: number } | null> {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/global');
      if (!r.ok) return null;
      const data = await r.json() as any;
      return {
        dominance: data.data?.market_cap_percentage?.btc ?? 0,
        change24h: 0, // CoinGecko free doesn't give 24h delta for dominance
      };
    } catch {
      return null;
    }
  }
}
```

**Step 4: Create `src/news/macro-analyst.ts`**

```typescript
import type { LLMClient } from '../llm/client.js';
import type { MacroSnapshot } from './macro-fetcher.js';

export interface MacroAnalysis {
  macro_summary: string;
  risk_environment: 'risk_on' | 'risk_off' | 'neutral';
  crypto_correlation_signal: 'bullish' | 'bearish' | 'neutral';
  key_levels: string[];
  refreshed_at: string;
}

const FALLBACK: MacroAnalysis = {
  macro_summary: 'Macro data unavailable.',
  risk_environment: 'neutral',
  crypto_correlation_signal: 'neutral',
  key_levels: [],
  refreshed_at: new Date().toISOString(),
};

const SYSTEM_PROMPT = `You are a macro markets analyst. Given current prices for oil, dollar index, S&P500, VIX, EUR/USD, and gold, return ONLY valid JSON (no markdown).

Return exactly this structure:
{
  "macro_summary": "2-3 sentence narrative of current macro environment and crypto implications",
  "risk_environment": "risk_on" | "risk_off" | "neutral",
  "crypto_correlation_signal": "bullish" | "bearish" | "neutral",
  "key_levels": ["DXY 104 resistance", "VIX 20 = fear threshold"],
  "refreshed_at": "<ISO timestamp>"
}

Rules:
- risk_off = DXY up + VIX up + S&P down = bad for crypto
- risk_on = DXY down + VIX down + S&P up = good for crypto
- Note intraday moves (day high/low vs current price) as trend context`;

export class MacroAnalystAgent {
  constructor(private llm: Pick<LLMClient, 'call'>) {}

  async analyze(snapshots: MacroSnapshot[], btcDominance?: { dominance: number } | null): Promise<MacroAnalysis> {
    try {
      let userPrompt = `Analyze current macro markets (${new Date().toISOString()}):\n\n`;
      for (const s of snapshots) {
        const trend = s.price > s.dayLow + (s.dayHigh - s.dayLow) * 0.5 ? 'upper half of range' : 'lower half of range';
        userPrompt += `${s.name} (${s.symbol}): $${s.price.toFixed(2)} | 24h: ${s.change24h >= 0 ? '+' : ''}${s.change24h.toFixed(2)}% | Day: L${s.dayLow.toFixed(2)}–H${s.dayHigh.toFixed(2)} (${trend})\n`;
      }
      if (btcDominance) {
        userPrompt += `BTC Dominance: ${btcDominance.dominance.toFixed(1)}%\n`;
      }

      const raw = await this.llm.call(SYSTEM_PROMPT, userPrompt);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { ...FALLBACK, refreshed_at: new Date().toISOString() };

      const parsed = JSON.parse(match[0]) as MacroAnalysis;
      parsed.refreshed_at = new Date().toISOString();
      console.log(`[MacroAnalyst] ${parsed.risk_environment} / crypto: ${parsed.crypto_correlation_signal}`);
      return parsed;
    } catch (err) {
      console.error('[MacroAnalyst] Error:', err);
      return { ...FALLBACK, refreshed_at: new Date().toISOString() };
    }
  }
}
```

**Step 5: Run tests**

```bash
npx vitest run tests/news/macro-analyst.test.ts
```

Expected: 2 tests PASS.

**Step 6: Run all tests**

```bash
npx vitest run tests/
```

Expected: all PASS.

**Step 7: Commit**

```bash
git add src/news/macro-fetcher.ts src/news/macro-analyst.ts tests/news/macro-analyst.test.ts
git commit -m "feat: add MacroFetcher + MacroAnalystAgent (oil/DXY/VIX/SP500/gold)"
```

---

### Task 5: TokenLogger + wire into LLMClient

**Files:**
- Create: `src/llm/token-logger.ts`
- Modify: `src/llm/client.ts`
- Create: `tests/llm/token-logger.test.ts`

**Step 1: Write the failing test**

Create `tests/llm/token-logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenLogger } from '../../src/llm/token-logger.js';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DIR = '/tmp/indic-test-tokens';
const LOG_FILE = join(TEST_DIR, 'tokens.jsonl');

describe('TokenLogger', () => {
  let logger: TokenLogger;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    logger = new TokenLogger(LOG_FILE);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('appends a JSONL entry', () => {
    logger.log({ method: 'analyze', tokensIn: 1000, tokensOut: 200, model: 'gpt-5.3-codex', cycle: 1 });
    const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.method).toBe('analyze');
    expect(entry.tokens_in).toBe(1000);
    expect(entry.tokens_out).toBe(200);
    expect(entry.ts).toBeDefined();
  });

  it('appends multiple entries', () => {
    logger.log({ method: 'call', label: 'news', tokensIn: 500, tokensOut: 100, model: 'gpt-5.3-codex', cycle: 1 });
    logger.log({ method: 'call', label: 'macro', tokensIn: 400, tokensOut: 80, model: 'gpt-5.3-codex', cycle: 1 });
    const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/llm/token-logger.test.ts
```

Expected: FAIL

**Step 3: Implement `src/llm/token-logger.ts`**

```typescript
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface TokenLogEntry {
  method: 'analyze' | 'call';
  label?: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  cycle?: number;
}

export class TokenLogger {
  constructor(private logFile: string) {}

  log(entry: TokenLogEntry): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        method: entry.method,
        label: entry.label,
        tokens_in: entry.tokensIn,
        tokens_out: entry.tokensOut,
        model: entry.model,
        cycle: entry.cycle,
      }) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');
    } catch {
      // Non-critical — never crash the bot over logging
    }
  }
}
```

**Step 4: Extract token usage in `src/llm/client.ts`**

In `streamSSE()`, find the `response.completed` event handling block (around line 175) and extract usage:

```typescript
// In streamSSE(), add a usage variable at the top:
let usageIn = 0;
let usageOut = 0;

// In the response.completed handler, add:
if (event.type === 'response.completed' && event.response) {
  const usage = event.response.usage;
  if (usage) {
    usageIn = usage.input_tokens ?? 0;
    usageOut = usage.output_tokens ?? 0;
  }
  // ... existing output extraction ...
}

// Return both content and usage:
return { content: output, usageIn, usageOut };
```

Update `streamSSE` return type and callers (`analyze`, `call`) to log tokens:

```typescript
// In analyze(), after const content = await this.streamSSE(response):
this.tokenLogger.log({
  method: 'analyze',
  tokensIn: content.usageIn,
  tokensOut: content.usageOut,
  model: this.model,
});

// In call(), same pattern with method: 'call', label param
```

Add `tokenLogger` to `LLMClient` constructor:

```typescript
import { TokenLogger } from './token-logger.js';
// In constructor:
private tokenLogger = new TokenLogger('logs/tokens.jsonl');
```

**Step 5: Run all tests**

```bash
npx vitest run tests/
```

Expected: all PASS. (streamSSE return type change may need test updates — fix `mockSSEResponse` in `client.test.ts` if needed.)

**Step 6: Commit**

```bash
git add src/llm/token-logger.ts tests/llm/token-logger.test.ts src/llm/client.ts
git commit -m "feat: add TokenLogger — log tokens_in/out per LLM call to logs/tokens.jsonl"
```

---

### Task 6: Wire macro into TradingLoop + inject into prompt

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/llm/prompts.ts` (add macroAnalysis block)
- Modify: `src/index.ts` (instantiate MacroFetcher + MacroAnalystAgent)

**Step 1: Add macro deps to `TradingLoopDeps`**

In `src/trading-loop.ts`, add to `TradingLoopDeps`:

```typescript
import type { MacroFetcher } from './news/macro-fetcher.js';
import type { MacroAnalystAgent, MacroAnalysis } from './news/macro-analyst.js';

interface TradingLoopDeps {
  // ... existing fields ...
  macroFetcher?: MacroFetcher;
  macroAnalyst?: MacroAnalystAgent;
  macroRefreshIntervalMs?: number;  // default 10_800_000 (3h)
}
```

Add private state:

```typescript
private lastMacroRefresh = 0;
private lastMacroAnalysis: MacroAnalysis | undefined;
```

**Step 2: Add macro refresh in `runOnce()`**

After news refresh block, add:

```typescript
// Macro refresh (every 3h)
const macroIntervalMs = this.deps.macroRefreshIntervalMs ?? 10_800_000;
if (this.deps.macroFetcher && this.deps.macroAnalyst && Date.now() - this.lastMacroRefresh > macroIntervalMs) {
  try {
    console.log('[Macro] Refreshing macro market data...');
    const [snapshots, btcDom] = await Promise.all([
      this.deps.macroFetcher.fetch(),
      this.deps.macroFetcher.fetchBTCDominance(),
    ]);
    this.lastMacroAnalysis = await this.deps.macroAnalyst.analyze(snapshots, btcDom);
    this.lastMacroRefresh = Date.now();
  } catch (err) {
    console.error('[Macro] Refresh failed:', err);
  }
}
```

**Step 3: Pass macro + recentNewsWithAge into prompt data**

In the `buildUserPrompt` call (around line 127):

```typescript
const recentNewsWithAge = this.deps.newsCache.getRecentItems(48);

const promptData: EnrichedPromptData = {
  snapshots,
  indicators: indicatorsMap,
  indicators4h: indicators4hMap,
  portfolio,
  signals: signalBuffer.drain(),
  news: [],
  fearGreed,
  sessionNotes: memory.getNotes(),
  recentTrades: memory.getRecentTrades(),
  newsAnalysis,
  recentNewsWithAge,          // NEW
  macroAnalysis: this.lastMacroAnalysis,  // NEW
};
```

**Step 4: Add macro section to `buildEnrichedPrompt` in `prompts.ts`**

After `## Market Sentiment`, add:

```typescript
// Macro markets
if (data.macroAnalysis) {
  const m = data.macroAnalysis;
  const age = Math.round((Date.now() - new Date(m.refreshed_at).getTime()) / 3_600_000);
  prompt += `## Macro Markets (${age}h ago)\n`;
  prompt += `Environment: ${m.risk_environment.toUpperCase()} | Crypto signal: ${m.crypto_correlation_signal.toUpperCase()}\n`;
  prompt += `${m.macro_summary}\n`;
  if (m.key_levels.length > 0) {
    prompt += `Key levels: ${m.key_levels.join(' | ')}\n`;
  }
  prompt += '\n';
}
```

**Step 5: Instantiate in `src/index.ts`**

```typescript
import { MacroFetcher } from './news/macro-fetcher.js';
import { MacroAnalystAgent } from './news/macro-analyst.js';

// In main():
const macroFetcher = config.apifyToken ? new MacroFetcher(config.apifyToken) : undefined;
const macroAnalyst = macroFetcher ? new MacroAnalystAgent(llmClient) : undefined;

// Pass to TradingLoop deps:
macroFetcher,
macroAnalyst,
macroRefreshIntervalMs: 10_800_000,
```

**Step 6: Run all tests**

```bash
npx vitest run tests/
```

Expected: all PASS.

**Step 7: Commit**

```bash
git add src/trading-loop.ts src/llm/prompts.ts src/index.ts
git commit -m "feat: wire macro into trading loop — oil/DXY/VIX/SP500/gold every 3h in LLM prompt"
```

---

### Task 7: Token usage section in audit + deploy to VM

**Files:**
- Modify: `scripts/audit.ts`
- Deploy to VM

**Step 1: Add TOKEN USAGE section to `scripts/audit.ts`**

After BOT LOGS SUMMARY section, add:

```typescript
// ── TOKEN USAGE ────────────────────────────────────────────
section('TOKEN USAGE (logs/tokens.jsonl)');
const tokens = readJsonl('logs/tokens.jsonl');
if (tokens.length === 0) {
  console.log('  No token logs yet.');
} else {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTokens = tokens.filter(t => t.ts?.startsWith(todayStr));
  const totalIn = todayTokens.reduce((s, t) => s + (t.tokens_in ?? 0), 0);
  const totalOut = todayTokens.reduce((s, t) => s + (t.tokens_out ?? 0), 0);
  const avgIn = todayTokens.length > 0 ? Math.round(totalIn / todayTokens.length) : 0;

  row('Today calls',       todayTokens.length);
  row('Today tokens in',  `${totalIn.toLocaleString()}`);
  row('Today tokens out', `${totalOut.toLocaleString()}`);
  row('Avg per call',     `${avgIn.toLocaleString()} in`);

  // Biggest call today
  const biggest = todayTokens.reduce((max, t) => (t.tokens_in ?? 0) > (max.tokens_in ?? 0) ? t : max, todayTokens[0]);
  if (biggest) {
    const method = biggest.label ? `${biggest.method}:${biggest.label}` : biggest.method;
    row('Biggest call',    `${method} — ${(biggest.tokens_in ?? 0).toLocaleString()} in @ ${biggest.ts?.slice(11,16)}`);
  }
}
```

**Step 2: Run audit locally to check it compiles**

```bash
npm run audit:bot 2>&1 | grep -A 10 "TOKEN"
```

Expected: TOKEN USAGE section appears (may show "No token logs yet" if fresh).

**Step 3: Deploy to VM**

```bash
# Push code
git push origin feat/max-info-fetch

# Sync to VM
rsync -az -e "ssh -i ~/.ssh/google_compute_engine" \
  --exclude node_modules --exclude .git --exclude .worktrees --exclude tmp --exclude logs \
  /path/to/04_Indic/ mykolat@34.179.171.213:~/indic-bot/

# Install new deps on VM
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 \
  "cd ~/indic-bot && npm install && pm2 restart indic-bot --update-env"
```

**Step 4: Check VM logs**

```bash
npm run audit:remote
```

Expected: TOKEN USAGE section in audit output.

**Step 5: Commit**

```bash
git add scripts/audit.ts
git commit -m "feat: add TOKEN USAGE section to audit — daily call count, tokens in/out, biggest call"
```

---

## Summary

| Task | What it builds |
|------|---------------|
| 1 | `NewsDB` — SQLite with dedup, `getRecent(hours)` |
| 2 | Wire `NewsDB` into `NewsCache` — items stored in SQLite |
| 3 | Time-aware prompts — UTC session + `[Xh ago]` news format |
| 4 | `MacroFetcher` + `MacroAnalystAgent` — oil/DXY/VIX/SP500/gold |
| 5 | `TokenLogger` — append `logs/tokens.jsonl` after every LLM call |
| 6 | Wire macro + aged news into `TradingLoop` and `prompts.ts` |
| 7 | TOKEN USAGE audit section + deploy to VM |
