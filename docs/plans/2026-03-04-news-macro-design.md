# News Accumulation + Macro Intelligence Design

**Goal:** Persistent news accumulation (SQLite, forever), time-aware prompts, macro market tracking (oil, DXY, VIX, S&P500, gold), and token usage logging per request.

**Architecture:** Three new subsystems integrated into the existing trading cycle — SQLite news DB, MacroAnalystAgent (Apify + LLM, hourly), and token logger. No existing components removed.

---

## 1. News Database (SQLite)

**File:** `~/.indic-bot/news.db`
**Library:** `better-sqlite3` (synchronous, no async complexity)

```sql
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  coins TEXT NOT NULL,        -- JSON array: '["BTC","ETH"]'
  sentiment REAL NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(title, date)         -- dedup on insert
);
```

- **Insert:** `INSERT OR IGNORE INTO news ...` — no duplicates
- **Query for LLM:** `SELECT *, (julianday('now') - julianday(date)) * 24 AS age_hours FROM news WHERE date > datetime('now', '-48 hours') ORDER BY date DESC`
- **No deletion** — full history kept forever
- Replaces `news-cache.json` for storage; `news-history.jsonl` retired

**`src/news/news-db.ts`** — new class `NewsDB`:
- `insert(items: CryptoNews[]): void`
- `getRecent(hours: number): (CryptoNews & { age_hours: number })[]`
- `count(): number`

**`src/news/news-cache.ts`** — updated to use `NewsDB` internally; `NewsCacheState.items` sourced from DB

---

## 2. Time Awareness

**Current time injected into system prompt each cycle:**
```
Current time: 2026-03-04 19:45 UTC (Wednesday)
Trading session: EU close / US open overlap
```

Session detection logic:
- Asia: 00:00–08:00 UTC
- Europe: 07:00–16:00 UTC
- US: 13:00–22:00 UTC
- Overlap zones noted (e.g. "EU/US overlap 13–16 UTC")

**News in prompt formatted with age:**
```
[2h ago]  [BTC] Bitcoin broke $73K — bullish/short/importance:9
[14h ago] [ETH] Ethereum Foundation AI layer — bullish/medium/importance:6
[41h ago] [SOL] Backpack IPO rails — bullish/medium/importance:5
```

Implementation: `buildUserPrompt()` in `src/llm/prompts.ts` receives `recentNews: (CryptoNews & { age_hours: number })[]` and formats with `Math.round(age_hours)h ago`.

---

## 3. Macro Markets

**Refresh:** Once per hour (separate from news refresh)
**Storage:** `~/.indic-bot/macro-cache.json`

**Assets tracked:**
| Asset | Symbol |
|-------|--------|
| WTI Crude Oil | CL=F |
| DXY Dollar Index | DX-Y.NYB |
| S&P 500 | ^GSPC |
| VIX Fear Index | ^VIX |
| EUR/USD | EURUSD=X |
| Gold | GC=F |
| BTC Dominance | CoinGecko API (free) |

**`src/news/macro-fetcher.ts`** — `MacroFetcher`:
- Uses Apify Yahoo Finance scraper actor
- Returns `MacroSnapshot[]`: `{ symbol, price, change24h, changeWeek }`

**`src/news/macro-analyst.ts`** — `MacroAnalystAgent`:
- One `llm.call()` per hour
- Returns `MacroAnalysis`:
```typescript
interface MacroAnalysis {
  macro_summary: string;           // 2-3 sentence narrative
  risk_environment: 'risk_on' | 'risk_off' | 'neutral';
  crypto_correlation_signal: 'bullish' | 'bearish' | 'neutral';
  key_levels: string[];            // ["DXY 104 resistance", "VIX 20 threshold"]
  refreshed_at: string;
}
```

**`src/trading-loop.ts`** — `macroRefreshIntervalMs = 3_600_000` (1h), parallel refresh alongside news.

---

## 4. Token Logging

**File:** `logs/tokens.jsonl`

**Format:**
```jsonl
{"ts":"2026-03-04T19:00:00Z","method":"analyze","tokens_in":4200,"tokens_out":180,"model":"gpt-5.3-codex","cycle":47}
{"ts":"2026-03-04T19:01:00Z","method":"call","label":"news_analyst","tokens_in":1800,"tokens_out":420,"model":"gpt-5.3-codex","cycle":47}
{"ts":"2026-03-04T19:01:30Z","method":"call","label":"macro_analyst","tokens_in":900,"tokens_out":210,"model":"gpt-5.3-codex","cycle":47}
```

**Source:** SSE event `response.completed` → `event.response.usage.input_tokens` + `event.response.output_tokens`

**`src/llm/token-logger.ts`** — `TokenLogger`:
- `log(entry): void` — appendFileSync to `logs/tokens.jsonl`

**`src/llm/client.ts`** — after `streamSSE()`:
- Extract usage from `response.completed` event
- Call `tokenLogger.log(...)`

**Audit output** (`scripts/audit.ts`) — new TOKEN USAGE section:
```
════ TOKEN USAGE ════
Today total        12,400 in / 2,100 out
Per cycle avg      620 in / 105 out
Biggest call       analyze @ 19:00 — 4,200 in
```

---

## Data Flow (per cycle)

```
TradingLoop.runOnce()
  ├── MarketDataFetcher.getSnapshot() × 3 pairs
  ├── [if stale 20min] CryptoPanicClient.fetchNews()
  │     └── NewsDB.insert()           ← SQLite, dedup
  ├── [if stale 1h] MacroFetcher.fetch()
  │     └── MacroAnalystAgent.analyze() → macro-cache.json
  ├── NewsDB.getRecent(48h)           ← with age_hours
  ├── buildEnrichedPrompt(snapshots, indicators, recentNews, macroAnalysis, portfolio, currentTime)
  └── LLMClient.analyze()
        └── TokenLogger.log()
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/news/news-db.ts` | **NEW** — SQLite wrapper |
| `src/news/macro-fetcher.ts` | **NEW** — Apify Yahoo Finance |
| `src/news/macro-analyst.ts` | **NEW** — MacroAnalystAgent |
| `src/llm/token-logger.ts` | **NEW** — TokenLogger |
| `src/news/news-cache.ts` | **MODIFY** — use NewsDB |
| `src/llm/client.ts` | **MODIFY** — extract + log tokens |
| `src/llm/prompts.ts` | **MODIFY** — age_hours formatting, currentTime, macroAnalysis block |
| `src/trading-loop.ts` | **MODIFY** — macro refresh, pass currentTime |
| `scripts/audit.ts` | **MODIFY** — TOKEN USAGE section |
| `package.json` | **MODIFY** — add `better-sqlite3` |
