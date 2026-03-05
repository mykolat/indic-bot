# Architecture — Indic Bot

## Overview

Indic Bot is an automated crypto futures trading system that combines LLM-based analysis with hard-coded risk guardrails. It trades on Binance Futures using a hybrid decision-making approach: the LLM proposes trades based on multi-timeframe technical analysis, news, and macro data, while code-enforced guardrails prevent catastrophic risk.

## Trading Philosophy

- **Multi-timeframe confirmation**: 1h for timing, 4h for direction. Both must align for full-size entries.
- **Confluence-based entry**: Need 3+ of 5 factors (EMA alignment, RSI zone, VWAP, volume, news/macro catalyst).
- **Hybrid guardrails**: Soft rules in LLM prompts (overridable with high confidence) + hard guardrails in code (Risk Manager enforces limits regardless of LLM output).
- **Confidence scoring**: LLM rates each decision 1-100. Below `minConfidence` (default 55) = auto-rejected.
- **Adaptive risk**: Position sizing and leverage automatically reduced during drawdowns and extreme market sentiment.

## Component Diagram

```
Config Sources
  ├─ config.yaml ── trading params (git-versioned, AI-writable)
  └─ .env ───────── secrets only (API keys, tokens)
       │
       ▼
MarketData (Binance API)
  ├─ Candles (1h, 4h, 15m)
  ├─ Funding rate + history
  ├─ Open interest
  ├─ L/S ratio, order book
  └─ Portfolio state
       │
       ▼
Indicators (technical.ts)
  ├─ RSI, EMA20/50, ATR
  ├─ MACD, Bollinger Bands
  ├─ VWAP, Volume ratio
  └─ 4h indicators (same set)
       │
       ├─ NewsFetcher interface
       │    ├─ CryptoPanicClient (Apify)
       │    └─ (future: RssNewsFetcher, paid sources)
       │         └─ NewsAnalyst → structured signals
       ├─ Fear & Greed (alternative.me)
       ├─ Macro (Yahoo Finance → MacroAnalyst)
       │
       ▼
Prompts (prompts.ts)
  ├─ System prompt (strategy rules, confluence checklist)
  ├─ Enriched user prompt (all data + narratives)
  └─ Session context (P&L, risk status, last order)
       │
       ▼
LLM (3-layer fallback)
  ├─ Layer 1: Codex API (OAuth/JWT, full prompt)
  ├─ Layer 2: FallbackLLMClient (OpenAI API, HOLD/CLOSE only)
  └─ Layer 3: Rule-based (no LLM, emergency close)
       │
       ▼
Risk Manager (manager.ts)
  ├─ Confidence check (min 55)
  ├─ Leverage / position size limits
  ├─ Stop-loss presence + range
  ├─ Total margin exposure cap
  ├─ 4h trend confirmation
  ├─ Fear & Greed leverage cap
  ├─ Session loss scaling
  ├─ Duplicate position check
  └─ Max loss shutdown trigger
       │
       ▼
Order Executor (orders.ts)
  ├─ MARKET entry → STOP_MARKET SL → TAKE_PROFIT_MARKET TP
  ├─ SL failure = cancel trade (close position)
  ├─ TP failure = non-fatal (position still protected by SL)
  └─ CLOSE = MARKET reduceOnly with exact position size
       │
       ▼
Logger (JSONL files)
  ├─ decisions.jsonl (all LLM decisions + risk rejections)
  ├─ trades.jsonl (executed orders)
  ├─ errors.jsonl (failures)
  ├─ performance.jsonl (balance per cycle)
  ├─ tokens.jsonl (LLM token usage)
  └─ parse-errors.jsonl (LLM response parse failures)
```

## Data Flow Per Cycle

1. **Fetch** market snapshots for all pairs (candles, funding, OI, order book)
2. **Compute** indicators: 1h + 4h (RSI, EMA, MACD, Bollinger, VWAP, volume ratio)
3. **Auto-exit** stale positions (>8h <1% P&L) and max-hold (>24h)
4. **Refresh** news cache if stale (every 20min), macro data (every 3h)
5. **Build** enriched prompt with data narratives (volume alerts, VWAP bias, Bollinger alerts, funding trends, trade performance/streaks, session P&L/risk status)
6. **LLM** analyzes and returns JSON decisions with confidence scores
7. **Validate** each decision through Risk Manager (confidence, leverage, exposure, guardrails)
8. **Execute** approved trades with mandatory SL/TP
9. **Log** everything + update session memory
10. **Dynamic interval**: LLM suggests `next_check_minutes` (1-30). Capped to 1-2 min when positions open.

## Risk Management

### Hard Guardrails (code-enforced, LLM cannot bypass)

| Guardrail | Trigger | Action |
|-----------|---------|--------|
| Confidence check | `confidence < minConfidence` (55) | Reject trade |
| 4h trend mismatch | LONG in bearish 4h, confidence < 80 | Reject trade |
| Fear & Greed cap | F&G < 25 or > 85, leverage > cap (10x) | Reject trade |
| Session loss 5%+ | Drawdown >= 5% | Halve max leverage & size |
| Session loss 10%+ | Drawdown >= 10% | Cap leverage 5x, size 25% |
| Duplicate position | Same pair + same direction already open | Reject trade |
| SL failure | Stop-loss placement fails after entry | Close position immediately |
| Max loss shutdown | Session P&L <= -(maxLossPct% x balance) | Stop bot |

### Soft Rules (in LLM prompt, overridable with high confidence)

- Multi-timeframe confirmation (1h + 4h alignment)
- RSI entry zones (40-65 LONG, 35-60 SHORT)
- Volume threshold (>1x average)
- VWAP positioning
- Bollinger Band overbought/oversold avoidance
- Consecutive loss pair skipping

## LLM Resilience (3-Layer Fallback)

The bot never trades blind. If the primary LLM fails, it degrades gracefully through three layers.

### Layer 1: Codex API (primary)

- **Endpoint**: `chatgpt.com/backend-api/codex/responses` via SSE streaming
- **Auth**: OAuth/JWT token refresh (`oauth.ts`); fallback to `OPENAI_API_KEY` if set
- **Prompt**: Full enriched prompt with all market data, indicators, news, soul.md, session context
- **Output**: Full JSON decisions (LONG/SHORT/HOLD/CLOSE) with confidence, SL/TP, reasoning, `next_check_minutes`
- **Parse errors**: Smart regex extraction + retry on failure; bad JSON returns `[]` (HOLD all)

### Layer 2: FallbackLLMClient

- **Endpoint**: Standard OpenAI `/v1/chat/completions` via `OPENAI_API_KEY_FALLBACK`
- **Model**: `gpt-4o-mini`
- **Prompt**: Minimal — current positions + P&L + soul.md External Insights (Big Brother)
- **Output**: HOLD or CLOSE only (no new entries)
- **Trigger**: Layer 1 API error (not parse error)

### Layer 3: Rule-based (emergency)

- **No LLM call** — pure code logic
- **SL/TP enforcement**: Relies on existing stop-loss/take-profit orders on Binance
- **Emergency close**: If `sessionPnlPct < -5%`, closes all positions immediately
- **Big Brother**: Logs External Insights section from soul.md
- **Trigger**: Both Layer 1 and Layer 2 fail

### Circuit Breaker

`CircuitBreaker` (`src/utils/circuit-breaker.ts`) — 3 consecutive all-fail Binance cycles (all pairs fail in `Promise.allSettled`) triggers cycle skip to avoid hammering failing APIs.

## Soul System

The bot maintains a persistent identity document (`~/.indic-bot/soul.md`) that gives the LLM agent memory, self-reflection, and external insight awareness.

### Components

| Component | File | Purpose |
|-----------|------|---------|
| SoulKeeper | `src/memory/soul-keeper.ts` | Reads/writes soul.md sections |
| SoulReviewAgent | `src/memory/soul-review.ts` | LLM self-reflection (every ~20 cycles) |
| computeSoulStats | `src/memory/soul-stats.ts` | Computes win rate, streaks, pair performance |
| soul:insight CLI | `scripts/soul-insight.ts` | Manual/external insight injection |

### Soul Document Structure

| Section | Author | Update Frequency |
|---------|--------|-----------------|
| Identity | LLM (SoulReview) | Every ~20 cycles or after 3 losses |
| What I've Learned | LLM (SoulReview) | Same triggers |
| My Failure Patterns | LLM (SoulReview) | Same triggers |
| Current Regime View | LLM (SoulReview) | Same triggers |
| External Insights | External tools / manual | On-demand (max 5 entries) |
| Performance Stats | SoulKeeper (code) | Every cycle |
| Recent Rejections | SoulKeeper (code) | On each RISK_REJECTED (max 10) |
| Invisible Exits | SoulKeeper (code) | On AUTO_CLOSE (max 10) |

### Data Flow

1. **Every cycle**: SoulKeeper.updateStats() writes Performance Stats from last 20 trades
2. **On rejection**: SoulKeeper.addRejection() records RISK_REJECTED with reason
3. **On auto-close**: SoulKeeper.addInvisibleExit() records stale/max-hold exits
4. **Before LLM call**: soul.md content injected into prompt (before market data)
5. **Every ~20 cycles**: SoulReviewAgent sends soul.md + recent trades to LLM → updates narrative sections
6. **On-demand**: `npm run soul:insight "text"` adds external insight

## Configuration

Config split implemented: secrets in `.env`, trading params in `config.yaml` (git-versioned). `loadConfig()` merges both sources — secrets from environment variables, everything else from `config.yaml` with hardcoded defaults as final fallback.

### Secrets (`.env` only — never committed, never logged)

| Secret | Env Var |
|--------|---------|
| Binance API key | `BINANCE_API_KEY` |
| Binance API secret | `BINANCE_API_SECRET` |
| OpenAI API key | `OPENAI_API_KEY` |
| OpenAI fallback key | `OPENAI_API_KEY_FALLBACK` |
| Webhook secret | `WEBHOOK_SECRET` |
| Apify token | `APIFY_API_TOKEN` |
| xAI API key | `XAI_API_KEY` |

### Trading Params (`config.yaml`)

| Param | YAML Key | Default | Purpose |
|-------|----------|---------|---------|
| `minConfidence` | `trading.minConfidence` | 55 | Min LLM confidence to execute |
| `stalePositionHours` | `trading.stalePositionHours` | 8 | Auto-close stale positions |
| `maxHoldHours` | `trading.maxHoldHours` | 24 | Force close after N hours |
| `fearGreedLeverageCap` | `trading.fearGreedLeverageCap` | 10 | Max leverage in extreme F&G |
| `maxLeverage` | `trading.maxLeverage` | 20 | Absolute max leverage |
| `maxPositionPct` | `trading.maxPositionPct` | 50 | Max position size % of balance |
| `maxStopLossPct` | `trading.maxStopLossPct` | 5 | Max stop-loss percentage |
| `maxLossPct` | `trading.maxLossPct` | 10 | Session loss shutdown threshold |
| `maxExposurePct` | `trading.maxExposurePct` | 150 | Total margin exposure cap |
| `loopIntervalMs` | `trading.loopIntervalMs` | 60000 | Base loop interval (overridden by dynamic interval) |
| `pairs` | `trading.pairs` | `['BTCUSDT']` | Trading pairs |
| `newsRefreshIntervalH` | `trading.newsRefreshIntervalH` | 0.33 | News cache refresh interval (hours) |
| `churnCooldownMs` | `trading.churnCooldownMs` | 900000 | Cooldown after closing a pair (ms) |

## Deployment

- **GCP VM**: `34.179.171.213` (europe-west3-a, e2-small, Debian 12)
- **Process**: pm2 (`pm2 restart indic-bot`)
- **Logs**: `~/indic-bot/logs/`
- **State**: `~/.indic-bot/` (memory.json, news-cache.json, soul.md, oauth-credentials.json)

## In Development

### Shark Mode

Adaptive market regime detection with 5 regimes:

| Regime | Characteristics | Filter Profile |
|--------|----------------|----------------|
| Bull Trend | Strong uptrend, high momentum | Relaxed LONG filters, tight SHORT filters |
| Bear Trend | Strong downtrend, high momentum | Relaxed SHORT filters, tight LONG filters |
| Range | Low volatility, mean-reverting | Tight filters both directions, favor reversals |
| Breakout | Expanding volatility, volume surge | Relaxed filters for breakout direction |
| Capitulation | Extreme fear, liquidation cascades | Ultra-tight filters, reduce size, widen SL |

Key features:
- Regime detected from indicators (ATR, volume, EMA slope) with LLM override capability
- Adaptive filter profiles adjust confidence thresholds, leverage caps, and position sizing per regime
- Decision journal: every trade gets a "trade story" explaining the setup, regime context, and expected outcome
- Trade stories reviewed during SoulReview for pattern learning

### Command Center

Multi-agent architecture for richer market intelligence:
- Dedicated analyst agents (news, macro, technical) run independently
- Grok grounding via xAI API for real-time event verification
- Centralized command center aggregates analyst outputs before trading decisions
