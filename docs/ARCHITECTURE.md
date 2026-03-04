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
       ├─ News (CryptoPanic → NewsAnalyst → signals)
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
LLM (client.ts — OpenAI Codex SSE)
  ├─ JSON decisions with confidence
  ├─ Smart regex parsing + retry
  └─ Parse error logging
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
| Max loss shutdown | Session P&L <= -(maxLossPct% × balance) | Stop bot |

### Soft Rules (in LLM prompt, overridable with high confidence)

- Multi-timeframe confirmation (1h + 4h alignment)
- RSI entry zones (40-65 LONG, 35-60 SHORT)
- Volume threshold (>1x average)
- VWAP positioning
- Bollinger Band overbought/oversold avoidance
- Consecutive loss pair skipping

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

| Param | Env Var | Default | Purpose |
|-------|---------|---------|---------|
| `minConfidence` | `MIN_CONFIDENCE` | 55 | Min LLM confidence to execute |
| `stalePositionHours` | `STALE_POSITION_HOURS` | 8 | Auto-close stale positions |
| `maxHoldHours` | `MAX_HOLD_HOURS` | 24 | Force close after N hours |
| `fearGreedLeverageCap` | `FEAR_GREED_LEVERAGE_CAP` | 10 | Max leverage in extreme F&G |
| `maxLeverage` | `MAX_LEVERAGE` | 20 | Absolute max leverage |
| `maxPositionPct` | `MAX_POSITION_PCT` | 50 | Max position size % of balance |
| `maxStopLossPct` | `MAX_STOP_LOSS_PCT` | 5 | Max stop-loss percentage |
| `maxLossPct` | `MAX_LOSS_PCT` | 10 | Session loss shutdown threshold |

## Deployment

- **GCP VM**: `34.179.171.213` (europe-west3-a, e2-small, Debian 12)
- **Process**: pm2 (`pm2 restart indic-bot`)
- **Logs**: `~/indic-bot/logs/`
- **State**: `~/.indic-bot/` (memory.json, news-cache.json, soul.md, oauth-credentials.json)
