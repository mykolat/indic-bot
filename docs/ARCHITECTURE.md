# Architecture — Indic Bot

## Overview

Indic Bot is an automated crypto futures trading system that combines multi-agent LLM-based analysis with hard-coded risk guardrails. It trades on Binance Futures using a hybrid decision-making approach: autonomous agents propose trades based on multi-timeframe technical analysis, news, macro data, and long-term episodic memory, while code-enforced guardrails prevent catastrophic risk.

## Trading Philosophy

- **Multi-timeframe confirmation**: 1h for timing, 4h for direction. Both must align for full-size entries.
- **Confluence-based entry**: Need 3+ of 5 factors (EMA alignment, RSI zone, VWAP, volume, news/macro catalyst).
- **Consensus-driven (Swarm)**: Operates a multi-agent swarm when BTC volumeRatio > 1.5, gathering consensus between multiple persona-driven models before executing.
- **Memory-augmented (RAG)**: Retrieves historical similar market structures and past trade performance using Episodic Graph RAG (Embeddings + Cosine Similarity).
- **Confidence scoring**: Agents rate each decision 1-100. Below `minConfidence` (default 55) = auto-rejected.
- **Adaptive risk (Shark Mode)**: Position sizing and leverage automatically adapt to 5 identified market regimes.

## Component Diagram

```text
Config Sources
  ├─ config.yaml ── trading params (git-versioned, AI-writable)
  └─ .env ───────── secrets only (API keys, tokens)
       │
       ▼
Data Layer (Market & Intelligence)
  ├─ MarketData (Binance API: Candles, Funding, OI, L/S ratio, Order Book)
  ├─ Indicators (1h/4h: RSI, EMA, MACD, Bollinger, VWAP, Volume)
  ├─ News Pipeline (MaxInfoPipe: CryptoPanic + RSS via Promise.allSettled + dedup)
  ├─ Macro Data (Yahoo Finance via Apify: WTI, DXY, S&P500, VIX, Gold; BTC dominance via CoinGecko)
  ├─ Fear & Greed Index (alternative.me API)
  └─ Episodic Memory (EpisodicStore + EmbeddingClient for Graph RAG)
       │
       ▼
Grok Intelligence Guards (pre-cycle + pre-trade)
  ├─ FlashCrashScanner (cycle start: PANIC/IGNORE guard)
  ├─ DevilsAdvocate (pre-trade veto via X/Twitter search)
  └─ GrokGrounder (fact-checks high-importance news)
       │
       ▼
Prompt Builder & Context Injection
  ├─ System constraints (strategy rules, confluence checklist)
  ├─ Distilled Layer 1 Info (News & Macro summaries from Layer 1 Experts)
  └─ Historical Trade Graph Context (similar past setups via EpisodicAgent)
       │
       ▼
Intelligence Layer (Multi-Agent Swarm & Core)
  ├─ Layer 1 Swarm Consensus (activated when BTC volumeRatio > 1.5)
  │    ├─ Permabull Persona
  │    ├─ Permabear Persona
  │    ├─ Paranoid Risk Manager Persona
  │    └─ Narrative Expert (GrokClient — optional 4th persona)
  ├─ Layer 1 Single Agent (Core — normal operation)
  ├─ Layer 2 FallbackLLM (gpt-4o-mini via OPENAI_API_KEY_FALLBACK — HOLD/CLOSE only)
  └─ Layer 3 Rule-based (Emergency SL/TP; close all if sessionPnlPct < -5%)
       │
       ▼
Risk Manager (src/risk/manager.ts)
  ├─ Confidence check (min 55)
  ├─ Leverage / position size limits & 4h trend confirmation
  ├─ Fear & Greed cap / Session loss scaling
  └─ Duplicate position & Max loss shutdown guardrails
       │
       ▼
Order Executor (src/binance/orders.ts)
  ├─ MARKET entry → STOP_MARKET SL → TAKE_PROFIT_MARKET TP
  └─ CLOSE = MARKET reduceOnly with exact position size
       │
       ▼
Observability (Dual-Write)
  ├─ JSONL log files (logs/ directory — primary backup)
  └─ Supabase PostgreSQL (src/db/ — 19 tables, optional, fire-and-forget)
```

## Data Flow Per Cycle

1. **Flash Crash Guard**: `FlashCrashScanner` (Grok) checks for market panic. If PANIC → abort cycle.
2. **Fetch**: Market snapshots for all pairs in parallel (`Promise.allSettled`).
3. **Portfolio**: Get portfolio state; compute real `sessionPnl` from Binance balance delta.
4. **Compute**: Technical indicators (1h + 4h).
5. **Auto-exit**: Close stale positions (>8h with <1% P&L) and max-hold (>24h).
6. **News & Macro Refresh**: Refresh news cache if stale (CryptoPanic + RSS); refresh macro data every 3h.
7. **Memory Retrieval**: `EpisodicAgent` embeds current state, queries `EpisodicStore` via cosine similarity (threshold 0.7) to find past similar setups (Graph RAG).
8. **LLM Execution (Swarm or Single)**:
   - If BTC volumeRatio > 1.5: `SwarmAgent` runs 3 parallel personas + optional Grok narrative expert; computes weighted consensus.
   - Otherwise: single `LLMClient.analyze()`.
9. **Validate & Execute**: For each decision — churn cooldown → `RiskManager.validate()` → `OrderExecutor.execute()`. (`DevilsAdvocate` veto is implemented but not yet wired here.)
10. **Log & Reflect**: Log performance snapshot; every ~20 cycles trigger `MemoryReviewAgent`.

## Risk Management

### Hard Guardrails (code-enforced, LLM cannot bypass)

| Guardrail | Trigger | Action |
|-----------|---------|--------|
| Confidence check | `confidence < minConfidence` (55) | Reject trade |
| 4h trend mismatch | LONG in bearish 4h, confidence < 80 | Reject trade |
| F&G Leverage Cap | F&G < 25 or > 85, leverage > cap (10x) | Reject trade |
| Session drawdown | Drawdown >= 5% / 10% | Halve max / Cap to 5x & 25% size |
| Duplicate pos/SL | Same pair & direction / SL fails | Reject / Close |
| Max loss shutdown | Session P&L <= -(maxLossPct% x balance) | Stop bot completely |

### Soft Rules & Regimes (Shark Mode)

Adaptive market regime detection operates across 5 regimes (BullTrend, BearTrend, Range, Breakout, Capitulation) to adjust leverage caps, position sizing, and indicator filters. Regime classification uses F&G, ADX, EMA, VWAP, and volume. Each regime has a `FilterProfile` specifying RSI range, volumeMin, confluenceMin, leverageMultiplier, minConfidence, and SL/TP style.

Files: `src/market/regime-classifier.ts`, `src/market/filter-profiles.ts`

## LLM Resilience & Multi-Agent Structure

The bot never trades blind. The intelligence layer is highly robust and relies on multi-agent consensus and structured fallbacks.

### Primacy: Multi-Agent Swarm (`SwarmAgent`)

- Triggered when BTC volumeRatio > 1.5.
- Coordinates 3 parallel personas (permabull, permabear, paranoid_risk_manager) + optional 4th Grok `narrative_expert`.
- Parses parallel completions and aggregates them into a weighted mathematical consensus.

File: `src/llm/swarm-agent.ts`

### Layer 1 Experts

Three parallel LLM calls each cycle via `runLayer1Experts()` (NewsExpert, MacroExpert, MemoryExpert). Results injected into the main prompt as `layer1Reports`.

File: `src/llm/agents.ts`

### Fallback Layers

- **Layer 1 Single Agent** (`src/llm/client.ts`): Primary standalone LLM. ChatGPT Codex API via SSE streaming with OAuth. Smart JSON extraction with targeted regex + retry on parse failure.
- **Layer 2 Minimal Agent** (`src/llm/fallback-client.ts`): Fallback to `gpt-4o-mini` via `OPENAI_API_KEY_FALLBACK`. Minimal prompt; HOLD/CLOSE only.
- **Layer 3 Rule-based**: Pure code logic executing current SL/TP. Closes all positions if `sessionPnlPct < -5%`.
- **Circuit Breaker** (`src/utils/circuit-breaker.ts`): 3 consecutive all-fail Binance cycles → skip cycle.

## Grok Intelligence Layer

All Grok features require `XAI_API_KEY`. The generic wrapper is `GrokClient` (`src/llm/grok-client.ts`), using model `grok-4-1-fast-reasoning` against `api.x.ai`.

### FlashCrashScanner (`src/news/flash-crash.ts`)

- Runs at the start of every cycle before any market data fetching.
- Returns `PANIC` or `IGNORE`.
- If `PANIC`, the entire cycle is aborted immediately.

### DevilsAdvocate (`src/risk/devils-advocate.ts`)

- Pre-trade veto agent powered by Grok.
- Searches X/Twitter for reasons NOT to enter the proposed trade.
- Returns `{ veto: boolean, reason?: string }`.
- **Note**: Implemented but not yet wired into `TradingLoop`; currently dead code.

### GrokGrounder (`src/news/grok-grounder.ts`)

- Fact-checks high-importance news (importance >= threshold) against X/Twitter via Grok.
- Prevents the bot from acting on misreported or manipulated headlines.

### GrokClient (`src/llm/grok-client.ts`)

- Generic xAI API wrapper used by FlashCrashScanner, DevilsAdvocate, GrokGrounder, and SwarmAgent's narrative_expert.

## News Intelligence Pipeline

### MaxInfoPipe Architecture

The news pipeline runs CryptoPanic and RSS fetchers in parallel via `Promise.allSettled`, then deduplicates headlines by title across sources before analysis.

- **CryptoPanic** (`src/news/cryptopanic.ts`): Headlines via Apify (`APIFY_API_TOKEN`). Checks Apify dataset age before triggering new actor runs to avoid unnecessary costs.
- **RSS Fetcher** (`src/news/rss-fetcher.ts`): `RssNewsFetcher` — CoinDesk, CoinTelegraph, Decrypt RSS feeds using `fast-xml-parser`.
- **SourceHealthMonitor** (`src/news/source-health.ts`): Tracks success/failure rates per source.
- **NewsAnalystAgent** (`src/news/news-analyst.ts`): LLM classifies headlines into structured signals with `importance` (1–10), `direction`, and `catalyst`.
- **GrokGrounder** (`src/news/grok-grounder.ts`): Fact-checks high-importance headlines against X/Twitter.

### Persistence

- **NewsCache** (`src/news/news-cache.ts`): File cache at `~/.indic-bot/news-cache.json`; fractional hours supported (e.g. 0.33).
- **NewsDB** (`src/news/news-db.ts`): SQLite persistent store at `~/.indic-bot/news.db`; deduplicates by `(title, date)`.
- **news-history.jsonl**: Append-only history of every news fetch.

### Macro Data

- **MacroFetcher** (`src/news/macro-fetcher.ts`): Yahoo Finance data (WTI, DXY, S&P500, VIX, EUR/USD, Gold) via Apify + BTC dominance via CoinGecko. Refreshed every 3 hours (time-based, configurable via `macroRefreshIntervalMs`).
- **MacroAnalystAgent** (`src/news/macro-analyst.ts`): LLM macro summary → `MacroAnalysis`.
- **Fear & Greed** (`src/news/fear-greed.ts`): Fear & Greed index from alternative.me API.

## Memory & Soul System

The bot maintains a persistent hybrid identity and memory system that spans flat files and embedded graph retrieval (RAG).

### Components

| Component | File | Purpose |
|-----------|------|---------|
| EpisodicAgent & Store | `src/llm/episodic-agent.ts`, `src/memory/episodic-store.ts` | Graph RAG long-term memory; JSON file DB at `DATA_DIR/memory-graph.json`; cosine similarity search |
| EmbeddingClient | `src/llm/embedding-client.ts` | `text-embedding-3-small` via OpenAI; cosine similarity threshold 0.7 |
| MemoryKeeper | `src/memory/memory-keeper.ts` | Manages `~/.indic-bot/memory.md` with section-level read/write (learned, failures, regime, insights, stats, rejections, invisibleExits, verifiedIntel) |
| MemoryReviewAgent | `src/memory/memory-review.ts` | LLM meta-reflection every ~20 cycles, after 3+ consecutive losses, or on 3%+ balance change |
| MemoryStats | `src/memory/memory-stats.ts` | Computes win rate, streaks, pair performance from TradeRecord[] |
| SessionState | `src/memory/session.ts` | Session state management |

### Persistent State (`~/.indic-bot/`)

| File | Contents |
|------|----------|
| `memory.json` | Session notes + last 20 closed trades + `start_balance` + `last_order_result` |
| `memory.md` | Persistent bot identity document (auto-updated stats, rejections, exits + LLM-written narrative) |
| `$DATA_DIR/memory-graph.json` | Episodic graph RAG store (embeddings + episodes). Default: `./tmp/memory-graph.json`; set `DATA_DIR=~/.indic-bot` on production VM |
| `news-cache.json` | Current news analysis cache |
| `news.db` | SQLite persistent news store (deduplication) |
| `news-history.jsonl` | Append-only history of every news fetch |

## Observability Database

Supabase PostgreSQL unified telemetry store with 19 tables covering the full chain: prompt → decision → execution → P&L.

Files: `src/db/connection.ts`, `src/db/types.ts`, `src/db/repository.ts`

### Table Groups (19 total)

| Group | Tables |
|-------|--------|
| Core | `sessions`, `cycles`, `trade_decisions`, `trade_executions`, `trade_closes`, `risk_validations` |
| LLM | `llm_conversations`, `swarm_personas`, `token_usage` |
| Intelligence | `news_articles`, `news_analyses`, `macro_snapshots`, `macro_analyses` |
| Memory | `episodic_memories` (pgvector), `trade_stories`, `memory_reviews` |
| Observability | `errors`, `webhook_signals`, `indicator_snapshots` |

### Key Design

- `cycle_id` is the spine — every table links to a cycle.
- Full trade lifecycle: `conversation → decision → execution → close`.
- **Dual-write**: JSONL log files continue as backup alongside DB writes.
- **DB is optional**: Bot runs fine without `DATABASE_URL`/`SUPABASE_PASS`. All DB writes are fire-and-forget with `.catch(() => {})`. Never crashes the bot.

## Logging

All log files are in the `logs/` directory in JSONL format. JSONL files are the primary backup regardless of DB availability.

| File | Contents |
|------|----------|
| `decisions.jsonl` | All LLM decisions + RISK_REJECTED entries |
| `trades.jsonl` | Executed LONG/SHORT/CLOSE trades |
| `errors.jsonl` | Order failures, loop errors |
| `performance.jsonl` | Balance + open positions per cycle; `cycleCount` resets on restart; includes `volumeRatio`, `confluence` (0–5), `confluenceFactors`, `regime` |
| `decisions-journal.jsonl` | Detailed per-decision journal (regime, filters applied, indicators snapshot) via `DecisionJournal` (`src/logging/decision-journal.ts`) |
| `trade-stories.jsonl` | Narrative per trade (entry/exit regime, story, lesson) via `TradeStoryLogger` (`src/logging/trade-story.ts`) |
| `parse-errors.jsonl` | LLM response parse failures |
| `tokens.jsonl` | LLM token usage per call via `TokenLogger` (`src/llm/token-logger.ts`) |

## Configuration

Config is split into two files with distinct purposes:

- `config.yaml` — all trading parameters, LLM model config, webhook port. Git-versioned. Parsed by `js-yaml` in `loadConfig()`. Changes require `pm2 restart indic-bot`.
- `.env` — secrets only (API keys). Never read directly; always via `loadConfig()`. Never logged or committed.

`loadConfig()` in `src/config.ts` merges both sources, with hardcoded defaults as fallback if `config.yaml` is missing.

### Environment Variables (`.env`)

| Variable | Purpose |
|----------|---------|
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Binance Futures API credentials |
| `BINANCE_TESTNET` | Set `true` to use `demo-fapi.binance.com` |
| `OPENAI_API_KEY` | OpenAI OAuth fallback (if set, used instead of OAuth JWT) |
| `OPENAI_API_KEY_FALLBACK` | Secondary key for Layer 2 `gpt-4o-mini` fallback |
| `XAI_API_KEY` | xAI API key for GrokClient (FlashCrashScanner, DevilsAdvocate, GrokGrounder, SwarmAgent narrative_expert) |
| `APIFY_API_TOKEN` | Apify token for CryptoPanic news fetcher and MacroFetcher (Yahoo Finance) |
| `SUPABASE_PASS` | Supabase password — builds connection URL automatically for Observability DB |
| `DATABASE_URL` | Custom PostgreSQL URL (alternative to `SUPABASE_PASS`) |
| `ENABLE_SWARM` | optional — set `false` to disable `SwarmAgent` even when `volumeRatio > 1.5` (default: enabled) |
