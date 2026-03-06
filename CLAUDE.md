# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # run bot (tsx, no compile step)
npm run test          # run all tests
npm run build         # compile TypeScript → dist/
npm run audit:bot     # live account snapshot (Binance + logs + news)
npm run audit:md      # markdown audit report → docs/deepresult/audit_history/
npm run audit:remote  # run audit on GCP VM via SSH
npm run deploy        # rsync + deploy to GCP VM
npm run soul:insight "text" # inject external insight into memory.md

# Run a single test file:
npx vitest run tests/risk/manager.test.ts

# Run tests for a directory:
npx vitest run tests/binance/

# Bot process management:
pm2 start "npm run dev" --name indic-bot
pm2 restart indic-bot   # picks up config changes (use --update-env for .env changes)
pm2 logs indic-bot
pm2 flush indic-bot
```

## Architecture

**Entry point**: `src/index.ts` wires all components and starts the trading loop + Express webhook server.

**Dual-Loop Architecture:**

**Watchdog** (`src/watchdog.ts` — 1 min, algorithmic):
- Fetches lightweight market data (price, OI, funding, order book) via `getQuickSnapshot()` — no candles
- Diffs against last DB snapshot — writes only when changed
- Anomaly detection: price spike >2%/min, OI spike >10%
- No LLM calls — pure algorithmic monitoring
- Writes to `market_snapshots` table

**Brain** (`src/trading-loop.ts` → `TradingLoop.runOnce()`) — min 10 min schedule (no positions) or config default (with positions):
1. **Flash Crash Guard** — `FlashCrashScanner` (Grok) checks for market panic; if PANIC → abort cycle
2. Fetch market snapshots for all pairs in parallel (`Promise.allSettled`)
3. Get portfolio state + compute real sessionPnl from Binance balance delta
4. Compute 1h and 4h technical indicators
5. Auto-exit stale positions (>8h <1% P&L) and max-hold (>24h)
6. Refresh news cache if stale (CryptoPanic + RSS) + macro data (every 3h)
7. **Graph RAG** — `EpisodicAgent` retrieves similar past episodes from `EpisodicStore`
8. **Position Context** — SL/TP prices + entry thesis from DB visible in prompt; min hold time (10 min) prevents premature closes
9. **Watchdog Summary** — aggregated market data from DB since last Brain cycle
10. **Swarm or Single LLM** — if BTC volumeRatio > 1.5, `SwarmAgent` runs Multi-Agent Debate (5 personas + judge); otherwise single `LLMClient.analyze()`
11. For each decision: min hold time check → churn cooldown → `RiskManager.validate()` → `OrderExecutor.execute()`
12. Log performance snapshot; every ~20 cycles trigger `MemoryReviewAgent`

**Config split** — two files, two purposes:
- `.env` — secrets only (API keys). Never read directly; always via `loadConfig()`. Never modify or log.
- `config.yaml` — all trading parameters, LLM model config, webhook port. Git-versioned. Parsed by `js-yaml` in `loadConfig()`.
- `loadConfig()` reads `config.yaml` for trading params (pairs, leverage, intervals, limits). `.env` keeps only API keys/secrets. Fallback to hardcoded defaults if `config.yaml` missing.

### Intelligence Layer (`src/llm/`)

**Core LLM**:
- `client.ts` — ChatGPT Codex API via SSE streaming; `call()` for analyst agent, `analyze()` for trading decisions. Smart JSON extraction with targeted regex + retry on parse failure. Parse errors logged to `logs/parse-errors.jsonl`.
- `oauth.ts` — OpenAI OAuth token refresh (default auth); fallback to `OPENAI_API_KEY` if set
- `prompts.ts` — `buildSystemPrompt()` with comprehensive strategy. `buildEnrichedPrompt()` assembles all data + interpreted narratives.
- `cot-schema.ts` — `MandatoryCoTChecklist` interface + `validateCoTChecklist()` enforcing structured reasoning fields (macro_risk_score, liquidation_sweep, order_book_imbalance, etc.)

**Swarm Multi-Agent Debate** (`swarm-agent.ts`):
- `SwarmAgent.getConsensus()` — Multi-Agent Debate with 5 personas: `risk_manager`, `bull_thesis`, `bear_thesis`, `market_structure`, `devils_advocate` + optional `narrative_expert` via Grok
- Each expert outputs structured JSON (thesis, arguments, probability_of_success 0-100%, key_risks, confidence)
- 3-stage pipeline: generate → critique → revise (revise only for high-stakes: >3% PnL or >30% balance)
- Weighted judge aggregates by probability × confidence; Devil's Advocate risks get extra weight
- Uses `buildExpertSystemPrompt()` (lightweight, no decisions format) — NOT `buildSystemPrompt()`
- Triggered when BTC volumeRatio > 1.5
- LLM calls: 6-7 (Phase 1) / 11-12 (Phase 2 critique) / 16-17 (Phase 3 revise)

**Layer 1 Experts** (`agents.ts`):
- `runLayer1Experts()` — 3 parallel LLM calls each cycle (NewsExpert, MacroExpert, MemoryExpert)
- Results injected into main prompt as `layer1Reports`

**Graph RAG** (`episodic-agent.ts` + `embedding-client.ts`):
- `EpisodicAgent` embeds current market state, searches `EpisodicStore` for similar past episodes (cosine > 0.7)
- `EmbeddingClient` uses `text-embedding-3-small` via OpenAI

**Grok Integration** (`grok-client.ts`):
- `GrokClient` — generic xAI API wrapper (`api.x.ai`), default model `grok-4-1-fast-reasoning`
- Used by: SwarmAgent (narrative_expert), DevilsAdvocate, FlashCrashScanner, GrokGrounder
- Requires `XAI_API_KEY` env var

**LLM resilience — 3 layers**:
- Layer 1: Codex API (OAuth/JWT) — full prompt, swarm if needed
- Layer 2: `fallback-client.ts` — standard OpenAI `/v1/chat/completions` via `OPENAI_API_KEY_FALLBACK`; minimal prompt; HOLD/CLOSE only; `gpt-4o-mini`
- Layer 3: Rule-based — no LLM; SL/TP on Binance; if `sessionPnlPct < -5%` → close all positions
- `CircuitBreaker` (`src/utils/circuit-breaker.ts`) — 3 consecutive all-fail Binance cycles → skip cycle

### Risk Layer (`src/risk/`)

**Risk Manager** (`manager.ts`):
- Validates every LONG/SHORT before execution with `ValidationContext` (indicators4h, fearGreed)
- Checks: confidence (min 55), leverage, position size %, stop-loss presence/range, total margin exposure %
- Hard guardrails: 4h trend confirmation, F&G leverage cap, session loss scaling, duplicate position check
- Shutdown trigger: `sessionPnl <= -(maxLossPct% × balance)` or `-(maxLossUsd)` if pct=0
- HOLD, CLOSE, FETCH_NEWS bypass all checks

### News & Macro System (`src/news/`)

- `news-fetcher.ts` — `NewsFetcher` interface for pluggable sources
- `cryptopanic.ts` — CryptoPanic headlines via Apify (`APIFY_API_TOKEN`)
- `rss-fetcher.ts` — `RssNewsFetcher`: CoinDesk, CoinTelegraph, Decrypt RSS feeds (`fast-xml-parser`)
- `source-health.ts` — `SourceHealthMonitor`: tracks success/failure rates per source
- `news-analyst.ts` — LLM classifies headlines into structured signals (importance 1–10, direction, catalyst)
- `news-cache.ts` — file cache at `~/.indic-bot/news-cache.json`; fractional hours work (e.g. 0.33)
- `news-db.ts` — SQLite persistent store at `~/.indic-bot/news.db`; deduplicates by `(title, date)`
- `flash-crash.ts` — `FlashCrashScanner`: Grok-powered PANIC/IGNORE guard at cycle start
- `grok-grounder.ts` — `GrokGrounder`: fact-checks high-importance news against X/Twitter
- `macro-fetcher.ts` — `MacroFetcher`: Yahoo Finance data (WTI, DXY, S&P500, VIX, EUR/USD, Gold) via Apify + BTC dominance via CoinGecko
- `macro-analyst.ts` — `MacroAnalystAgent`: LLM macro summary → `MacroAnalysis`
- `fear-greed.ts` — Fear & Greed index from alternative.me API

### Market Regime — Shark Mode (`src/market/`)

- `regime-classifier.ts` — `classifyRegime()`: 5 regimes (BullTrend, BearTrend, Range, Breakout, Capitulation) with confidence scoring based on F&G, ADX, EMA, VWAP, volume
- `filter-profiles.ts` — `FilterProfile` per regime: RSI range, volumeMin, confluenceMin, leverageMultiplier, minConfidence, slStyle, tpStyle

### Order Execution (`src/binance/orders.ts`)

- Every LONG/SHORT places 3 orders: MARKET (entry) → STOP_MARKET → TAKE_PROFIT_MARKET
- SL/TP use `closePosition: 'true'` (not `quantity + reduceOnly`) — required by Binance Futures API
- **SL failure = cancel trade**: if SL placement fails, entry position is immediately closed
- CLOSE uses MARKET reduceOnly with exact position size fetched from Binance

### Memory System (`src/memory/`)

- `memory-keeper.ts` — manages `~/.indic-bot/memory.md` with section-level read/write (learned, failures, regime, insights, stats, rejections, invisibleExits, verifiedIntel). Includes `backupHistory()` to `docs/deepresult/memory_history/`
- `memory-review.ts` — LLM self-reflection agent, triggers every ~20 cycles, after 3+ consecutive losses, or on 3%+ balance change
- `memory-stats.ts` — computes MemoryStats (win rate, streaks, pair performance) from TradeRecord[]
- `episodic-store.ts` — `EpisodicStore`: JSON file DB at `DATA_DIR/memory-graph.json`; cosine similarity search
- `session.ts` — session state management
- `scripts/soul-insight.ts` — CLI for injecting external insights (`npm run soul:insight "text"`)

### Logging (`src/logging/` + `logs/`)

- `decision-journal.ts` — `DecisionJournal`: logs decisions with regime, confidence, filters, indicators to `decisions-journal.jsonl`
- `trade-story.ts` — `TradeStoryLogger`: narrative per trade (entry/exit regime, story, lesson)
- `token-logger.ts` — logs LLM token usage to `logs/tokens.jsonl`

**Log files** (`logs/` directory, JSONL):
- `decisions.jsonl` — all LLM decisions + RISK_REJECTED entries
- `trades.jsonl` — executed LONG/SHORT/CLOSE
- `errors.jsonl` — order failures, loop errors
- `performance.jsonl` — balance + open positions per cycle; `cycleCount` resets on restart; includes `volumeRatio`, `confluence` (0–5), `confluenceFactors`, `regime`
- `decisions-journal.jsonl` — detailed per-decision journal (regime, filters applied, indicators snapshot)
- `trade-stories.jsonl` — narrative per trade (entry/exit regime, story, lesson)
- `parse-errors.jsonl` — LLM response parse failures
- `tokens.jsonl` — LLM token usage per call

### Persistent State (all in `~/.indic-bot/`)

- `memory.json` — session notes + last 20 closed trades + `start_balance` + `last_order_result`
- `memory.md` — persistent bot identity document (auto-updated stats, rejections, exits + LLM-written narrative)
- `memory-graph.json` — episodic graph RAG store (embeddings + episodes)
- `news-cache.json` — current news analysis
- `news.db` — SQLite persistent news store
- `news-history.jsonl` — append-only history of every news fetch

**TradingView webhook** (`src/webhook/`): Express server on `WEBHOOK_PORT` (default 3000); signals buffered in-memory and drained each cycle into LLM context.

### Observability Database (`src/db/`)

**Supabase PostgreSQL** — unified telemetry store. 19 tables covering the full chain: prompt → decision → execution → P&L. Enabled via `SUPABASE_PASS` or `DATABASE_URL` env var.

- `connection.ts` — PG pool via `pg` npm, `initPool()` / `closePool()`
- `types.ts` — TypeScript interfaces matching all 19 tables
- `repository.ts` — typed insert/query methods for every table + pgvector search

**Tables (20):**
- **Core:** `sessions`, `cycles`, `trade_decisions`, `trade_executions` (incl. `entry_thesis`), `trade_closes`, `risk_validations`, `market_snapshots`
- **LLM:** `llm_conversations`, `swarm_personas`, `token_usage`
- **Intelligence:** `news_articles`, `news_analyses`, `macro_snapshots`, `macro_analyses`
- **Memory:** `episodic_memories` (pgvector), `trade_stories`, `memory_reviews`
- **Observability:** `errors`, `webhook_signals`, `indicator_snapshots`

**Key design:** `cycle_id` is the spine — every table links to a cycle. `conversation → decision → execution → close` provides full trade lifecycle traceability. JSONL files continue as backup (dual-write).

**Requires:** `SUPABASE_PASS` env var (builds connection URL automatically) or `DATABASE_URL` for custom PG. Bot runs fine without either (graceful fallback, JSONL only).

## Infrastructure

**GCP VM (production)**: `34.179.171.213` — europe-west3-a (Frankfurt), e2-small, Debian 12
- SSH: `ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213`
- Bot runs via pm2, logs at `~/indic-bot/logs/pm2.log`
- This IP is whitelisted in Binance API key
- Session files: `~/.indic-bot/` (oauth-credentials.json, memory.json, news-cache.json, memory.md, memory-graph.json)
- Deploy: `npm run deploy` or manual `rsync -az -e "ssh -i ~/.ssh/google_compute_engine" --exclude node_modules --exclude .git /path/to/04_Indic/ mykolat@34.179.171.213:~/indic-bot/`

## Key Gotchas

- **TypeScript ESM** — all local imports require `.js` extension (e.g. `import ... from './config.js'`), even though files are `.ts`. This is required by `"module": "NodeNext"`.
- **`sessionPnl`** — computed from real Binance balance delta (`currentBalance - startBalance`). `start_balance` persisted in `memory.json`.
- **Churn cooldown** — stored in `TradingLoop.lastClosedAt` (in-memory Map). Resets on bot restart.
- **Testnet URL** — `demo-fapi.binance.com` (not `testnet.binancefuture.com`). Set via `BINANCE_TESTNET=true` in `.env`.
- **LLM layer switching** — `LLMClient.analyze()` throws on API errors (not parse errors). TradingLoop catches this and falls to Layer 2 or 3. Parse errors (bad JSON) still return `[]` (HOLD all positions).
- **`Promise.allSettled`** for market snapshots — one pair failing won't kill the whole cycle. All-fail triggers circuit breaker.
- **Big Brother** — `memory.md` External Insights section is the "Big Brother" message. Injected into Layer 2 prompt and logged in Layer 3 emergency close.
- **`config.yaml`** is read at startup. Changes require `pm2 restart indic-bot`.
- **`NewsFetcher` interface** (`src/news/news-fetcher.ts`) — swap news sources without touching TradingLoop.
- **Grok features** require `XAI_API_KEY` env var for FlashCrashScanner, DevilsAdvocate, SwarmAgent narrative_expert, GrokGrounder.
- **Apify caching** — news fetchers check latest Apify dataset age before triggering new actor runs to avoid unnecessary costs.
- **DB is required** — Watchdog writes market snapshots, Brain reads position contexts + watchdog summaries. Requires `SUPABASE_PASS` or `DATABASE_URL`. All DB writes are fire-and-forget with `.catch(() => {})`. Never crashes the bot.
- **`pg` npm** — direct PG connection pool (not Supabase JS client). Dashboard reads via Supabase REST API.

**Fetch timeouts** (`src/utils/fetch-timeout.ts`): AbortController-based timeouts for all external API calls (15s Apify, 10s CoinGecko, 5s Fear&Greed).

## Planned (not yet implemented)

- ~~`config.yaml` migration~~ — **DONE**. `loadConfig()` reads `config.yaml` with `js-yaml`. See `src/config.ts`.
- ~~Shark Mode~~ — **DONE**. 5 regimes, filter profiles, regime classifier. See `src/market/`.
- ~~Swarm Consensus~~ — **DONE**. Multi-persona parallel analysis. See `src/llm/swarm-agent.ts`.
- ~~Graph RAG~~ — **DONE**. Episodic memory with embeddings. See `src/llm/episodic-agent.ts`.
- ~~Grok Integration~~ — **DONE**. FlashCrashScanner, GrokGrounder, SwarmAgent narrative_expert wired. Devil's advocate functionality provided by SwarmAgent `devils_advocate` persona.
- ~~Command Center Phase 1~~ — **DONE**. `RssNewsFetcher` and `GrokGrounder` both wired in `TradingLoop` (`rssFetcher`, `grokGrounder` deps). See `src/news/rss-fetcher.ts`, `src/news/grok-grounder.ts`, `docs/plans/2026-03-05-command-center-phase1-plan.md`.
- `npm run audit:debug` — JSON mode for AI-driven self-healing audit. Debug scripts exist (`scripts/debug-decisions.ts`, `debug-orders.ts`, `debug-positions.ts`, `debug-trades.ts`) but the `audit:debug` npm command is **not yet added** to `package.json`. See `docs/plans/2026-03-04-audit-design.md`.
- ~~DevilsAdvocate pre-trade veto~~ — **Removed**. Standalone class deleted; functionality covered by SwarmAgent `devils_advocate` persona.
- ~~Observability DB~~ — **DONE**. 19 tables in Supabase PostgreSQL + pgvector. See `src/db/` and `docs/plans/2026-03-05-observability-db-design.md`.
