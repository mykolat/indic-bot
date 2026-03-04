# Autonomous Position Management Design

**Date:** 2026-03-04
**Goal:** Run autonomously for 1 week on Binance Futures testnet, targeting configurable returns (e.g. +100%/day), then analyze logs.

---

## Context

The bot already:
- Fetches market data (50 candles, funding rate, open interest)
- Computes RSI, EMA20/50, ATR per pair
- Fetches Fear & Greed Index + CryptoPanic news via Apify
- LLM (GPT-5.3-codex via ChatGPT OAuth) makes LONG/SHORT/CLOSE/HOLD decisions
- Risk manager validates before execution
- Executes orders on Binance Futures testnet

**What's missing for autonomous week-long operation:**
1. LLM doesn't know entry price / unrealized P&L → can't decide when to exit
2. No memory between sessions (OAuth token refreshes, crashes)
3. No hourly performance snapshots for post-analysis
4. Risk params too conservative for aggressive target returns
5. No process manager for crash recovery
6. OAuth token expires ~24h → needs auto-refresh

---

## Architecture

### Phase 1 — Today (critical for launch)

#### 1.1 Position Entry Context
Extend `Position` interface and `MarketDataFetcher.getPortfolioState()` to include:
```typescript
interface Position {
  pair: string;
  sizeUsd: number;       // notional
  leverage: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;    // NEW: from Binance p.entryPrice
  unrealizedPnlPct: number; // NEW: computed from p.unrealizedProfit / margin
  heldHours: number;     // NEW: computed from p.updateTime
}
```
Binance `getPositions()` already returns `entryPrice`, `unrealizedProfit`, `updateTime` — just map them.

LLM prompt shows:
```
Open positions:
  BTCUSDT SHORT | entry $87,400 | held 2.5h | P&L: -$8.2 (-2.4%) | SL: 3%
```

#### 1.2 Aggressive System Prompt + Strategy Rules
The system prompt includes configurable targets and strategy rules:

```
TARGET: Aim for ${MIN_TAKE_PROFIT_PCT}%+ take-profits. Do NOT scalp < ${MIN_TAKE_PROFIT_PCT}%.
STRATEGY (override allowed with explicit reasoning):
  - Trend-following: prefer LONG if EMA20 > EMA50, SHORT if EMA20 < EMA50
  - Momentum: enter on strong RSI momentum (40-65 range for LONG, 35-60 for SHORT)
  - Funding arbitrage: extreme negative funding → crowded shorts → lean LONG
  - Exit: position P&L < -${MAX_STOP_LOSS_PCT}% → CLOSE; RSI overbought on LONG → CLOSE
  - Drawdown: if P&L < -(MAX_STOP_LOSS_PCT/2)% and held > 4h with no progress → CLOSE
```

#### 1.3 JSON Session Memory
File: `~/.indic-bot/memory.json`
```json
{
  "session_notes": "200-word LLM summary of current session patterns",
  "recent_trades": [...last 20 closed trades with outcomes],
  "last_updated": "ISO timestamp"
}
```
- Read at bot startup, inject `session_notes` + last 5 trades into every LLM prompt
- Updated after each closed position (LLM generates new `session_notes`)
- Persists across OAuth refreshes and restarts

#### 1.4 Performance Logger
New log file: `logs/performance.jsonl`
```json
{"ts":"...","balance":5012.5,"openPositions":2,"sessionPnl":12.5,"cycleCount":42}
```
Written every cycle. Enables post-week analysis of equity curve.

#### 1.5 Configurable Risk Parameters
New `.env` variables:
```env
TARGET_RETURN_PCT=100      # informational — passed to LLM as context
MIN_TAKE_PROFIT_PCT=5      # LLM must target >= this TP
MAX_LEVERAGE=20
MAX_POSITION_PCT=50        # up to 50% balance per position
MAX_EXPOSURE_PCT=150       # can be over-leveraged (futures)
MAX_STOP_LOSS_PCT=5
LOOP_INTERVAL_MS=60000     # 1-minute cycles
```

---

### Phase 2 — This Week: SQLite + Daily Compaction

Replace `memory.json` with `~/.indic-bot/trading.db` (better-sqlite3):

```sql
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  ts TEXT, pair TEXT, action TEXT,
  reasoning TEXT, entry_price REAL,
  size_pct INTEGER, leverage INTEGER
);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER,
  pnl_usd REAL, pnl_pct REAL,
  duration_hours REAL,
  closed_at TEXT
);

CREATE TABLE daily_summaries (
  date TEXT PRIMARY KEY,
  summary TEXT,    -- LLM-generated 200-word analysis
  lessons TEXT     -- key takeaways
);
```

**Daily job** (runs at 00:00 UTC via `node-cron`):
1. Query yesterday's `decisions` + `outcomes`
2. LLM generates `summary` + `lessons`
3. Insert into `daily_summaries`

LLM prompt context: last 7 `daily_summaries` + last 10 `decisions` + open positions.

---

### Phase 3 — Later: Vector RAG

If SQLite context retrieval proves insufficient:
- Add local embeddings via `@xenova/transformers` (all-MiniLM-L6-v2, ~25MB, no API cost)
- Embed each `decision.reasoning + market_conditions`
- At cycle time: find top-3 semantically similar past decisions → add their outcomes to prompt
- Only implement if Phase 2 memory isn't improving decision quality

---

## Autonomous Operation

### Process Management (pm2)
```bash
pm2 start "npm run dev" --name indic-bot --restart-delay=5000 --max-restarts=100
pm2 save
pm2 startup
```

### OAuth Auto-Refresh
Token from `~/.indic-bot/oauth-credentials.json` includes `refresh_token`.
Current `oauth.ts` has `updateAccessToken()`. Add background refresh:
- Check token expiry before each cycle
- If expires in < 30 min → refresh silently
- Update `LLMClient` via `updateAccessToken()`

---

## Logging for Post-Week Analysis

```
logs/
  decisions.jsonl    — every LLM decision with reasoning
  trades.jsonl       — executed orders with orderId
  performance.jsonl  — hourly balance + P&L snapshots  ← NEW
  errors.jsonl       — all errors for debugging
```

After 1 week: analyze which pairs/times/conditions produced profit.

---

## Implementation Order (Today)

1. `src/risk/manager.ts` — update config for aggressive params
2. `src/binance/market-data.ts` — add entryPrice, unrealizedPnlPct, heldHours to Position
3. `src/llm/prompts.ts` — add entry context + strategy rules + MIN_TAKE_PROFIT_PCT to prompt
4. `src/memory/session.ts` — NEW: JSON memory read/write
5. `src/logger/index.ts` — add performance snapshot logging
6. `src/config.ts` — add TARGET_RETURN_PCT, MIN_TAKE_PROFIT_PCT, updated risk params
7. `src/index.ts` — wire memory + token refresh
8. `.env` — update risk params
9. `pm2` setup for autonomous operation
10. `npx tsc --noEmit` + tests pass + `npm run dev` smoke test
