# Indic Bot — Deep Research Document

> This document describes the complete AS-IS state of the Indic crypto futures trading bot.
> Purpose: feed to Gemini Deep Research for industry comparison, trend analysis, and strategic recommendations.
> Generated: 2026-03-05

---

## 1. Project Overview

**Indic Bot** is an automated crypto futures trading system running on Binance Futures with real money. It uses an LLM (OpenAI Codex API) for trade decision-making combined with hard-coded risk guardrails that the LLM cannot override.

**Tech Stack:**
- TypeScript ESM (Node.js), `tsx` for development
- OpenAI Codex API (SSE streaming) as primary LLM
- Binance Futures API via `binance` npm package
- SQLite (`better-sqlite3`) for news deduplication
- Express.js for TradingView webhook signals
- pm2 for process management in production
- JSONL files for structured logging

**Deployment:**
- GCP VM (e2-small, Debian 12, Frankfurt/europe-west3-a)
- 24/7 operation via pm2
- Deploy via rsync + pm2 restart

**Scale:**
- 8 trading pairs: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT
- 32 source files, 19 test files, ~3,655 lines of code
- 12 production dependencies
- Dynamic loop interval: 1-30 minutes (LLM decides)

---

## 2. Architecture AS-IS

### Component Diagram

```
Config Sources
  ├─ .env (secrets: API keys)
  └─ config.yaml (trading params, git-versioned)
       │
       ▼
  loadConfig() → Config object
       │
       ▼
MarketData (Binance API)
  ├─ Candles (1h, 4h, 15m × 50 each)
  ├─ Mark price, funding rate + history
  ├─ Open interest, L/S ratio
  └─ Order book depth, portfolio state
       │
       ▼
Indicators (technical.ts)
  ├─ RSI(14), EMA(20/50), ATR
  ├─ MACD(12/26/9), Bollinger Bands(20,2σ)
  ├─ VWAP, Volume ratio
  └─ Computed for both 1h and 4h timeframes
       │
       ├─ News: NewsFetcher interface → CryptoPanicClient → NewsAnalyst (LLM)
       ├─ Fear & Greed: alternative.me API
       ├─ Macro: Yahoo Finance via Apify → MacroAnalyst (LLM)
       ├─ Soul: soul.md persistent identity
       │
       ▼
Enriched Prompt (prompts.ts)
  ├─ System prompt: strategy rules, confluence checklist, confidence guide
  ├─ User prompt: all data + interpreted narratives
  └─ Soul content, session P&L, risk status
       │
       ▼
LLM Decision Engine (3-layer resilience)
  ├─ Layer 1: Codex API (OAuth SSE) — full context, all actions
  ├─ Layer 2: FallbackLLMClient (OpenAI standard, gpt-4o-mini) — HOLD/CLOSE only
  └─ Layer 3: Rule-based — no LLM, emergency close if P&L < -5%
       │
       ▼
Risk Manager (manager.ts)
  ├─ Confidence gate (min 55)
  ├─ Leverage + position size limits
  ├─ Stop-loss mandatory (1-5%)
  ├─ Total margin exposure cap (150%)
  ├─ 4h trend confirmation
  ├─ Fear & Greed leverage cap
  ├─ Session loss scaling (5%→halve, 10%→cap)
  └─ Duplicate position + shutdown trigger
       │
       ▼
Order Executor (orders.ts)
  ├─ MARKET entry → STOP_MARKET SL → TAKE_PROFIT_MARKET TP
  ├─ SL failure = cancel trade (close position immediately)
  └─ CLOSE = MARKET reduceOnly
       │
       ▼
Logging (JSONL)
  ├─ decisions.jsonl, trades.jsonl, errors.jsonl
  ├─ performance.jsonl, tokens.jsonl, parse-errors.jsonl
  │
Soul System (memory/)
  ├─ soul.md — persistent identity (8 sections)
  ├─ memory.json — session notes, last 20 trades, start_balance
  └─ SoulReview — LLM self-reflection every ~20 cycles
```

### Source Files (32 TypeScript files)

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/` | `index.ts`, `trading-loop.ts`, `config.ts` | Entry point, main cycle, config loading |
| `src/llm/` | `client.ts`, `fallback-client.ts`, `prompts.ts`, `oauth.ts`, `token-logger.ts` | LLM integration (5 files) |
| `src/binance/` | `client.ts`, `market-data.ts`, `orders.ts` | Exchange integration (3 files) |
| `src/risk/` | `manager.ts` | Risk validation |
| `src/indicators/` | `technical.ts` | RSI, EMA, MACD, Bollinger, VWAP |
| `src/news/` | `cryptopanic.ts`, `news-analyst.ts`, `news-cache.ts`, `news-db.ts`, `news-fetcher.ts`, `types.ts`, `macro-fetcher.ts`, `macro-analyst.ts`, `fear-greed.ts` | News & macro intelligence (9 files) |
| `src/memory/` | `soul-keeper.ts`, `soul-review.ts`, `soul-stats.ts`, `session.ts` | Persistent memory (4 files) |
| `src/webhook/` | `server.ts`, `signal-buffer.ts` | TradingView signals (2 files) |
| `src/utils/` | `circuit-breaker.ts`, `fetch-timeout.ts`, `soul-utils.ts` | Utilities (3 files) |
| `src/logger/` | `index.ts` | JSONL structured logging |

### Data Flow Per Cycle

1. **Fetch** market snapshots for all pairs in parallel (`Promise.allSettled`)
2. **Portfolio** state from Binance (positions + USDT balance) + compute real sessionPnl
3. **Compute** indicators: 1h + 4h (RSI, EMA, MACD, Bollinger, VWAP, volume ratio)
4. **Auto-exit** stale positions (>8h <1% P&L) and max-hold (>24h)
5. **Refresh** news cache if stale (every 20min), macro data (every 3h)
6. **Build** enriched prompt with data narratives + soul.md + session context
7. **LLM** analyzes and returns JSON decisions with confidence scores + `next_check_minutes`
8. **Validate** each decision through Risk Manager
9. **Execute** approved trades with mandatory SL/TP
10. **Log** everything + update soul stats + soul review (every ~20 cycles)
11. **Dynamic interval**: LLM suggests `next_check_minutes` (1-30), capped to 1-2 min when positions open

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `binance` | ^3.4.3 | Binance Futures API (USDMClient) |
| `better-sqlite3` | ^12.6.2 | News SQLite storage |
| `dotenv` | ^17.3.1 | .env loading |
| `express` | ^5.2.1 | Webhook server |
| `fast-xml-parser` | ^5.4.2 | RSS XML parsing (for upcoming RSS feeds) |
| `global-agent` | ^4.1.2 | HTTP proxy support |
| `js-yaml` | ^4.1.1 | config.yaml parsing |
| `openai` | ^6.25.0 | OpenAI SDK (fallback client) |
| `chalk` | ^5.6.2 | Console colors |
| `typescript` | ^5.9.3 | Compiler |
| `@mariozechner/pi-ai` | ^0.55.4 | **UNUSED** — no imports found |

---

## 3. Trading Strategy

### Decision-Making Flow

The bot uses a hybrid approach: **LLM proposes, Code enforces**.

1. The LLM receives a comprehensive prompt with all available data (technicals, news, macro, soul memory, portfolio, recent trades)
2. It returns JSON decisions with confidence scores (1-100) for each pair
3. The Risk Manager validates every LONG/SHORT before execution
4. Only validated decisions reach the Order Executor
5. HOLD, CLOSE, and FETCH_NEWS bypass risk validation

### Multi-Timeframe Analysis

- **4h timeframe** determines direction (EMA20 vs EMA50 alignment)
- **1h timeframe** determines entry timing
- Both must align for full-size entries; 4h bearish + 1h bullish = HOLD or minimal leverage (3-5x)
- 15m RSI is computed inline for additional timing context

### Confluence Scoring

Entry requires 3+ of 5 factors:
1. EMA trend alignment (1h + 4h same direction)
2. RSI in entry zone (40-65 LONG, 35-60 SHORT)
3. Price above/below VWAP (matching direction)
4. Volume > 1x average
5. News/macro catalyst (importance >= 5 or macro signal aligns)

### 3-Layer LLM Resilience

| Layer | Engine | Scope | Trigger |
|-------|--------|-------|---------|
| 1 | Codex API (OAuth SSE) | Full prompt, all actions, next_check_minutes | Default |
| 2 | FallbackLLMClient (gpt-4o-mini) | HOLD/CLOSE only, minimal prompt | Layer 1 API error |
| 3 | Rule-based (no LLM) | Close all if P&L < -5%, use SL/TP on Binance | Layer 2 also fails |

Layer switching: `LLMClient.analyze()` **throws** on API errors (not parse errors). TradingLoop catches and falls through. Parse errors (bad JSON) return `[]` (HOLD all) — no layer switch.

### Dynamic Loop Intervals

The LLM returns `next_check_minutes` (1-30) with each decision set:
- Open positions: 1-2 min (monitor SL/TP, exits)
- Strong setup forming: 1-3 min
- Normal market, no positions: 5-10 min
- Low volume, dead tape: 15-30 min

Hard cap: when positions are open, interval is forced to 1-2 min regardless of LLM suggestion.

### Prompt Structure

The system prompt (~2000 chars) contains:
- Trading rules (multi-timeframe, confluence, RSI/volume/VWAP zones)
- Funding & OI signal interpretation
- Market regime awareness (Fear & Greed scaling)
- Position management rules (exit conditions, streak-based skipping)
- Risk scaling awareness (what the code enforces)
- JSON response format specification

The user prompt (~5000-10000 chars per cycle) contains:
- Session status (P&L, risk level)
- Soul content (persistent identity + memory)
- Per-pair technical analysis with interpreted narratives
- Fear & Greed, macro analysis
- News signals with age and importance
- Trade performance (win/loss ratio, streaks)
- Portfolio state, recent closed trades
- TradingView signals (if any)

---

## 4. Risk Management Framework

### Hard Guardrails (code-enforced, LLM cannot bypass)

| Guardrail | Trigger | Action |
|-----------|---------|--------|
| Confidence check | `confidence < 55` | Reject trade |
| Leverage limit | `leverage > maxLeverage` (25x) | Reject trade |
| Position size | `size_pct > maxPositionPct` (60%) | Reject trade |
| Stop-loss mandatory | `stop_loss_pct` missing or 0 | Reject trade |
| Stop-loss range | `stop_loss_pct > 5%` | Reject trade |
| Margin exposure | Total margin > 150% of balance | Reject trade |
| 4h trend mismatch | LONG in 4h bearish, confidence < 80 | Reject trade |
| Fear & Greed cap | F&G < 25 or > 85, leverage > 10x | Reject trade |
| Session loss 5%+ | Drawdown >= 5% | Halve max leverage & size |
| Session loss 10%+ | Drawdown >= 10% | Cap leverage 5x, size 25% |
| Duplicate position | Same pair + same direction open | Reject trade |
| SL placement fails | Stop-loss order rejected by Binance | Close position immediately |
| Max loss shutdown | `sessionPnl <= -(maxLossPct% x balance)` | Stop bot |

### Soft Rules (in LLM prompt, overridable with high confidence)

- Multi-timeframe confirmation (1h + 4h alignment)
- RSI entry zones (40-65 LONG, 35-60 SHORT)
- Volume threshold (>1x average)
- VWAP positioning
- Bollinger Band overbought/oversold avoidance
- Consecutive loss pair skipping

### Circuit Breaker Pattern

- Tracks consecutive all-pair Binance API failures
- After 3 consecutive failures: skip entire cycle
- Resets on first successful market data fetch
- **Known issue**: No half-open state or time-based recovery — bot stays stuck until restart

### Churn Cooldown

- After closing a position, 15-minute cooldown on same pair
- Stored in-memory (`TradingLoop.lastClosedAt` Map)
- Resets on bot restart

---

## 5. Soul System & Memory

### Persistent Identity (soul.md)

The bot maintains `~/.indic-bot/soul.md` — a markdown document giving the LLM persistent memory and self-awareness across cycles.

| Section | Author | Update Frequency |
|---------|--------|-----------------|
| Identity | LLM (SoulReview) | Every ~20 cycles or after 3 consecutive losses |
| What I've Learned | LLM (SoulReview) | Same triggers |
| My Failure Patterns | LLM (SoulReview) | Same triggers |
| Current Regime View | LLM (SoulReview) | Same triggers |
| External Insights | External tools / manual CLI | On-demand (max 5 entries) |
| Performance Stats | SoulKeeper (code) | Every cycle |
| Recent Rejections | SoulKeeper (code) | On each RISK_REJECTED (max 10) |
| Invisible Exits | SoulKeeper (code) | On AUTO_CLOSE (max 10) |

### Session Memory (memory.json)

- Session notes (free text)
- Last 20 closed trades with P&L
- `start_balance` for session P&L calculation
- `last_order_result` string

### News Storage

- **news-cache.json** — current analysis with fetchedAt/analyzedAt timestamps
- **news-history.jsonl** — append-only log of every news fetch
- **news.db** — SQLite with dedup by (title, date), `getRecent(hours)` with computed `age_hours`

### External Insights ("Big Brother")

- Injected via CLI: `npm run soul:insight "text"`
- Stored in soul.md `## External Insights` section
- Read by Layer 2 fallback prompt and Layer 3 emergency logic
- Max 5 entries

---

## 6. Code Audit Findings

A comprehensive code audit was performed across all 32 source files. Findings are organized by severity.

### Critical Issues

| # | Module | Issue | Impact |
|---|--------|-------|--------|
| 1 | `orders.ts` | **SL/TP computed from pre-trade ticker price, not actual fill price.** MARKET orders have slippage, so the actual entry price differs from the ticker. SL/TP percentages won't match intended values. | Financial risk — SL could be tighter or wider than intended |
| 2 | `orders.ts` | **`close()` does not cancel orphaned SL/TP orders.** After closing a position, existing STOP_MARKET and TAKE_PROFIT_MARKET orders remain on the book and could trigger on a future position. | Unexpected order execution on new positions |
| 3 | `orders.ts` | **`roundQuantity`/`roundPrice` use hardcoded precision** instead of Binance `exchangeInfo` tickSize/stepSize. BTC=3 decimals, ETH=2, all others=1. Wrong for many altcoins. | Order rejection by Binance or incorrect quantities |
| 4 | `client.ts` | **No fetch timeout on Codex API calls.** Primary LLM client uses bare `fetch()` with no timeout (fallback correctly uses `fetchWithTimeout`). Can hang indefinitely, blocking the entire trading loop. | Bot freeze |
| 5 | `client.ts` | **No SSE streaming timeout.** The `streamSSE` while-loop has no maximum duration. A stalled connection freezes the bot. | Bot freeze |
| 6 | `technical.ts` | **RSI uses non-standard formula** (simple averaging instead of Wilder's smoothing). Values diverge from TradingView/Binance charts. LLM interprets RSI based on standard definitions, creating signal mismatch. | Incorrect trading signals |
| 7 | `circuit-breaker.ts` | **No recovery path.** Once triggered (3 consecutive failures), stays open forever. No half-open state, no time-based reset. Bot permanently skips cycles until manually restarted. | Requires manual intervention to recover |

### Important Issues

| # | Module | Issue | Impact |
|---|--------|-------|--------|
| 8 | `cryptopanic.ts`, `macro-fetcher.ts` | **15s timeout for synchronous Apify actor runs** — actors commonly exceed 15s, causing frequent silent failures returning `[]` | Missing news/macro data |
| 9 | `news-db.ts` | **NewsDB is completely unused** — never instantiated anywhere in the codebase. Dead code. | Code bloat |
| 10 | `news-cache.ts` | **Corrupted `fetchedAt` produces NaN** — `NaN > number` is false, so cache **never refreshes** | Permanently stale news |
| 11 | `macro-fetcher.ts` | **`changeWeek` is actually 52-week change**, mislabeled. Downstream consumers misinterpret the data. | Incorrect macro analysis |
| 12 | `news-analyst.ts`, `macro-analyst.ts`, `client.ts` | **Greedy JSON regex** (`/\{[\s\S]*\}/`) matches from first `{` to last `}`. Multiple JSON-like blocks or braces in commentary cause incorrect extraction. | LLM parse failures |
| 13 | `manager.ts` | **No validation for `size_pct <= 0` or `leverage <= 0`** — zero/negative values pass all checks and create zero-quantity orders | Binance API errors |
| 14 | `fear-greed.ts` | **Fallback to 50 (Neutral) silently masks API failures.** Risk manager won't apply F&G leverage caps when API is down. | Missing risk protection |
| 15 | `session.ts` | **File corruption causes silent data loss** — `load()` swallows JSON parse errors, `setStartBalance` overwrites with defaults | Lost trade history |
| 16 | `soul-keeper.ts` | **No error handling on readFileSync/writeFileSync** — disk issues crash the bot | Bot crash on non-critical operation |
| 17 | `trading-loop.ts` | **Multiple unprotected async calls** — `fetchFearGreed()`, news fetch, `orders.close()` lack try/catch. Single API failure crashes entire cycle. | Skipped cycles |
| 18 | `client.ts` | **Stateless retry sends "fix your JSON" to stateless API** — Codex API has no conversation memory. Retry is unreliable. | Wasted API calls |
| 19 | `oauth.ts` | **Interactive OAuth fallback blocks production** — on headless GCP VM, if callback server fails and refresh token expired, bot hangs forever waiting for stdin. | Bot freeze |
| 20 | `market-data.ts` | **`availableBalance` vs `balance` ambiguity** — `getPortfolioState` returns `availableBalance` (excludes margin) as `balanceUsd`, but the field name suggests total equity. | Potential position sizing errors |
| 21 | `soul-stats.ts` | **`profitFactor = 0` when all trades are wins** — semantically wrong. Misleads LLM soul review (looks like losing strategy). | Incorrect self-assessment |
| 22 | `soul-review.ts` | **`consecutiveLosses >= 3` triggers review every cycle** with no cooldown. Burns LLM tokens during loss streaks. | Unnecessary LLM costs |
| 23 | `index.ts` | **`Math.max` prevents LLM from setting shorter intervals** — if `defaultIntervalMs` is higher than LLM suggestion, default wins. Should likely be `Math.min` for a cap. | Ignoring LLM timing suggestions |
| 24 | `technical.ts` | **ATR uses simple average instead of Wilder's smoothing.** Values differ from standard platforms. | Indicator mismatch |
| 25 | `technical.ts` | **MACD signal line computation is O(n^2)** and seeds from short series instead of full history. | Performance + potential inaccuracy |
| 26 | `prompts.ts` | **`getTradingSession` has overlapping ranges** — produces valid but misleading session labels for certain UTC hours. | LLM receives inaccurate context |

### Minor Issues

| # | Module | Issue |
|---|--------|-------|
| 27 | `client.ts` | `alertCount` never resets — after 2 alerts, all future errors silently suppressed forever |
| 28 | `client.ts` | `emergencyAlert` uses macOS-only `afplay`/`say` — dead code on production Debian VM |
| 29 | `client.ts` | Unused imports: `MarketSnapshot`, `TradingViewSignal` |
| 30 | `client.ts` | Duplicated fetch headers (3 identical blocks) |
| 31 | `news-analyst.ts`, `macro-analyst.ts` | No runtime JSON schema validation — `as Type` casts provide zero safety |
| 32 | `trading-loop.ts` | News fetch logic duplicated (stale refresh + FETCH_NEWS handler) |
| 33 | `trading-loop.ts` | PnL USD calculation duplicated 3 times |
| 34 | `trading-loop.ts` | `news: []` always passed as empty array — vestigial field |
| 35 | `news-cache.ts` | `NewsSignal`/`NewsAnalysis` types defined here instead of `types.ts` |
| 36 | `config.ts` | No YAML value validation — `maxLeverage: "banana"` silently propagates |
| 37 | `config.ts` | `readFileSync`/`yaml.load` have no try/catch — malformed YAML crashes bot |
| 38 | `server.ts` | Webhook secret uses `!==` (timing-vulnerable) instead of `crypto.timingSafeEqual` |
| 39 | `server.ts` | No input validation on webhook body fields — potential prompt injection via `pair` field |
| 40 | `logger/index.ts` | `appendFileSync` has no try/catch — disk full crashes the bot |
| 41 | `logger/index.ts` | No log rotation — files grow indefinitely |
| 42 | `oauth.ts` | Credentials file written with default permissions (world-readable) |
| 43 | `session.ts`, `soul-keeper.ts` | Non-atomic read-modify-write patterns risk data loss on concurrent access |
| 44 | All file I/O | Synchronous file operations block the event loop |
| 45 | `market-data.ts` | `getMarkPrice`/`getOpenInterest`/`getOrderBook` not `.catch()`-wrapped unlike peer calls |
| 46 | `@mariozechner/pi-ai` | Unused dependency in package.json |

---

## 7. Current & Planned Development

### Shark Mode (IN PROGRESS)

**Problem:** Bot is a "cold analyst" — 98.8% HOLD rate (646/654 decisions). Hardcoded RSI zones, volume thresholds, and confluence requirements block entries in most market conditions.

**Solution:** 5 market regimes with adaptive filter profiles:

| Regime | Detection | RSI Range | Volume Min | Confluence | Max Leverage |
|--------|-----------|-----------|------------|------------|-------------|
| Bull Trend | EMA20>EMA50 + ADX>25 + price>VWAP | 45-80 | 0.6x | 2/5 | config |
| Bear Trend | EMA20<EMA50 + ADX>25 + price<VWAP | 20-55 | 0.6x | 2/5 | config |
| Range | ADX<20 + BB bandwidth<4% | 30-70 | 0.5x | 2/5 | config/2 |
| Breakout | Volume>1.5x + ATR>1.5x + outside BB | any | 1.2x | 3/5 | config |
| Capitulation | F&G<15 OR 4h drop>5% OR volume>3x | any | 0.8x | 1/5 | config/4 |

Key features:
- Rule-based regime classifier with LLM override capability
- Decision journal (full context per pair per cycle)
- Trade stories (LLM narrative on CLOSE, injected into next prompts)
- Dynamic prompt: regime-specific guidelines replace hardcoded rules

### Config Split (DONE)

- `.env` — secrets only (API keys), gitignored
- `config.yaml` — all trading parameters, git-versioned, parsed by `js-yaml`
- `loadConfig()` merges both with hardcoded defaults as fallback

### Trading Command Center (PLANNED)

Multi-agent architecture replacing the single-LLM approach:

**5 Analyst Agents** (Codex low reasoning — fast, cheap):
1. News Analyst — RSS from CoinDesk, CoinTelegraph, Decrypt
2. Macro Analyst — Yahoo Finance + BTC dominance
3. On-Chain Analyst — Arkham whale transfers + OI/funding
4. Social Analyst — Twitter crypto stream + Reddit sentiment
5. Grok Grounder — xAI API for fact-checking high-importance claims

**1 Chief Trader** (Codex medium reasoning):
- Receives pre-digested briefings from all analysts + technicals + soul.md
- Makes final trading decisions

**Data Sources (planned):**
- Direct RSS feeds (no Apify dependency for news)
- Twitter via `crypto-twitter-tracker` Apify actor
- Reddit via `reddit-intelligence-ai-v1` Apify actor
- Arkham Intelligence for whale tracking
- Grok xAI for X/Twitter search-based grounding

**Estimated cost:** ~$35-60/month Apify + existing Codex subscription

### Command Center Phase 1 (PLANNED, partially started)

- `NewsFetcher` interface created (done)
- `fast-xml-parser` installed (done)
- `RssNewsFetcher` (CoinDesk, CoinTelegraph, Decrypt) — planned
- `GrokGrounder` (xAI direct API) — planned
- `SourceHealthMonitor` (uptime + cost tracking) — planned
- Soul.md `Verified Intelligence` section — planned

---

## 8. Questions for Deep Research

### Architecture & Design

1. **How does our monolithic trading loop compare to event-driven architectures used by professional algo trading firms?** Our single `runOnce()` method handles data fetching, analysis, risk validation, and execution sequentially. Is this appropriate, or should we move to an event-driven architecture with separate data ingestion, analysis, and execution pipelines?

2. **Is our 3-layer LLM resilience pattern (primary -> fallback -> rules) a best practice, or are there better patterns for LLM-critical systems?** How do other LLM-dependent production systems handle API failures? Is our approach of degrading from full AI to HOLD/CLOSE-only to rule-based emergency close well-designed?

3. **Should the bot be split into microservices?** Currently everything runs in a single Node.js process. With the planned Command Center (5 analyst agents + 1 trader), should we use separate processes, message queues, or is the monolith appropriate for this scale?

4. **What are best practices for circuit breaker patterns in trading systems?** Our current implementation has no half-open state or time-based recovery. What do professional systems use?

### Trading Strategy

5. **How do professional quant funds handle market regime detection?** Compare our planned 5-regime classifier (Bull/Bear Trend, Range, Breakout, Capitulation) with industry approaches. Is rule-based classification sufficient, or do firms use ML-based regime detection (Hidden Markov Models, etc.)?

6. **Is LLM-based trading decision-making a viable long-term approach?** What are the current trends and academic research in using LLMs for financial decision-making? What are the known failure modes and risks?

7. **Our confluence scoring (3/5 factors) is hardcoded — are there better approaches?** Dynamic factor weighting, ML-based confluence, or adaptive thresholds based on market conditions?

8. **Our RSI uses simple averaging (Cutler's RSI) instead of Wilder's smoothing.** How significant is this divergence in practice? Should we switch to match TradingView/Binance standard calculations?

### Risk Management

9. **How does our risk framework compare to industry standards?** We have 13 guardrails. What guardrails are we missing? What do professional crypto trading firms use?

10. **Is our session-based P&L tracking appropriate?** We use balance delta from start of session (resets on restart). Should we use rolling-window P&L, daily P&L limits, or drawdown-from-peak metrics?

11. **What are best practices for position sizing in crypto futures?** Compare our fixed-percentage approach (`size_pct` of balance as margin) with Kelly criterion, volatility-targeting, or risk-parity approaches.

12. **How should we handle the SL/TP price issue?** Our SL/TP is computed from pre-trade ticker price, not fill price. What do professional systems do? Should we use the fill price, or is there a better approach like ATR-based stops?

### Operations & Infrastructure

13. **What are best practices for backtesting LLM-based trading strategies?** The core "model" is an LLM — how do you backtest non-deterministic decision-making? How do you avoid overfitting when the strategy is prompt-based?

14. **How should we monitor bot health and performance in production?** What metrics matter most? We currently have JSONL logs but no dashboards, alerting, or real-time monitoring.

15. **What are current trends in cost optimization for multi-LLM agent architectures?** Our planned Command Center uses 6 LLM calls per cycle. How do similar systems manage costs?

### Market Data & Intelligence

16. **What data sources do professional crypto trading firms use beyond what we have?** We use: technicals (candles, funding, OI), Fear & Greed, news (CryptoPanic), macro (Yahoo Finance). What else is commonly used?

17. **How effective is social sentiment (Twitter/Reddit) for crypto trading signal generation?** What does the research say about alpha from social signals in crypto markets?

18. **What's the state of on-chain analytics for short-term trading?** Is whale tracking (Arkham) actionable for futures trading, or is it more useful for longer timeframes?

### Roadmap Priorities

19. **Given our current architecture and planned features, what should be our development priorities?** We have three major initiatives: Shark Mode (regime-adaptive), Command Center (multi-agent), and infrastructure improvements (backtesting, monitoring). What order maximizes value?

20. **What's the ROI of adding more data sources vs improving decision-making quality?** Should we invest in broader data (Twitter, on-chain, Reddit) or deeper analysis (better indicators, better prompts, backtesting)?

21. **Should we invest in backtesting infrastructure before adding more features?** Currently we have no way to validate strategy changes except live trading. Is this a critical gap?

---

## Appendix: Test Coverage

19 test files covering all major modules:

| Module | Test File | Focus |
|--------|-----------|-------|
| Config | `config.test.ts` | YAML loading, defaults, env overrides |
| Binance | `binance/market-data.test.ts`, `binance/orders.test.ts` | Snapshots, portfolio, order execution |
| Indicators | `indicators/technical.test.ts` | RSI, EMA, ATR, MACD, Bollinger, VWAP |
| LLM | `llm/client.test.ts`, `llm/fallback-client.test.ts`, `llm/token-logger.test.ts` | SSE streaming, JSON parsing, token logging |
| News | `news/news-analyst.test.ts`, `news/news-cache.test.ts`, `news/news-db.test.ts`, `news/macro-analyst.test.ts` | Classification, caching, SQLite, macro |
| Risk | `risk/manager.test.ts` | All validation checks |
| Memory | `memory/session.test.ts`, `memory/soul-keeper.test.ts`, `memory/soul-stats.test.ts` | Persistence, sections, stats |
| Loop | `trading-loop.test.ts` | Full cycle integration |
| Utils | `utils/circuit-breaker.test.ts` | Failure tracking, reset |
| Webhook | `webhook/signal-buffer.test.ts` | Buffering, TTL, drain |
| Logger | `logger.test.ts` | JSONL appending |

## Appendix: Persistent Files

All in `~/.indic-bot/`:

| File | Format | Purpose |
|------|--------|---------|
| `memory.json` | JSON | Session notes, last 20 trades, start_balance |
| `news-cache.json` | JSON | Current news analysis + timestamps |
| `news.db` | SQLite | All news items (deduped by title+date) |
| `news-history.jsonl` | JSONL | Append-only history of every news fetch |
| `soul.md` | Markdown | Persistent identity (8 sections) |
| `oauth-credentials.json` | JSON | OpenAI OAuth tokens |
