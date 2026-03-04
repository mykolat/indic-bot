# Smart Bot Intelligence Upgrade — Design

**Goal:** Transform the bot from "makes decisions but can't learn" to "makes informed decisions, adapts to performance, and respects hard risk limits." Hybrid approach: soft rules in prompts (LLM guidelines) + hard guardrails in code (safety net). TDD throughout.

**Architecture:** Four categories of changes — (1) critical bug fixes, (2) decision intelligence with confidence scoring and code-enforced guardrails, (3) enhanced prompt engineering with data narratives, (4) feedback loops and resilience. No new external dependencies.

---

## 1. Critical Bug Fixes

### 1.1 Fix sessionPnL Tracking

**Problem:** `sessionPnl` in `TradingLoop` is self-tracked and only updated on successful CLOSE. If position closes externally (liquidation, manual), sessionPnl stays wrong. Risk manager's max-loss check compares against 0.

**Fix:**
- Store `startBalance` at first cycle (from Binance `getPortfolioState()`)
- Each cycle: `sessionPnl = currentBalance - startBalance` (real Binance data)
- Remove manual `this.sessionPnl += pnlUsd` tracking
- Persist `startBalance` to `~/.indic-bot/session-state.json` so it survives restarts

**Files:** `src/trading-loop.ts`, `src/memory/session.ts`

### 1.2 SL/TP Failure → Cancel Trade

**Problem:** Entry order succeeds, SL placement fails → position is UNPROTECTED. Bot logs "success".

**Fix:**
- If SL placement fails after entry: immediately close the position, return `{ success: false, error: 'SL failed, position closed' }`
- If TP placement fails: warn but keep position (SL is set)
- Log SL/TP failures to `logs/errors.jsonl` with severity "CRITICAL"

**Files:** `src/binance/orders.ts`

### 1.3 JSON Extraction Regex Fix

**Problem:** `/\{[\s\S]*\}/` is greedy — captures everything from first `{` to last `}`. If LLM writes explanation before JSON, entire text becomes one match.

**Fix:**
- Primary regex: look for `"decisions"` key: `/\{[^{}]*"decisions"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/`
- Fallback: original greedy regex
- Log parse failures to `logs/parse-errors.jsonl` with full raw response
- Retry once on parse failure: re-prompt "Your last response was not valid JSON"

**Files:** `src/llm/client.ts`

---

## 2. Decision Intelligence

### 2.1 Confidence Score

**Problem:** Bot treats tentative "maybe LONG" same as strong conviction "definitely LONG."

**Fix:**
- Add `"confidence": 1-100` to LLM decision JSON schema in system prompt
- Parse confidence from response in `client.ts`
- Add `confidence?: number` to `TradeDecision` interface
- Default to 50 if missing (backward compat)
- Risk manager: reject if `confidence < minConfidence` (configurable, default 55)

**Files:** `src/llm/prompts.ts`, `src/llm/client.ts`, `src/risk/manager.ts`

### 2.2 Hard Guardrails in Risk Manager

New validations (code-enforced, LLM cannot bypass):

| Guardrail | Condition | Action | Override |
|-----------|-----------|--------|----------|
| 4h timeframe | LONG but 4h trend bearish | REJECT | confidence >= 80 |
| 4h timeframe | SHORT but 4h trend bullish | REJECT | confidence >= 80 |
| Fear/Greed cap | F&G < 25 or > 85 | maxLeverage = min(requested, 10x) | None |
| Session loss scaling | sessionPnl < -5% | maxLeverage halved, size halved | None |
| Session loss scaling | sessionPnl < -10% | maxLeverage = 5x, size = 25% | None |
| Duplicate position | Already LONG this pair | REJECT LONG | None |
| Duplicate position | Already SHORT this pair | REJECT SHORT | None |

**Risk manager receives:** `indicators4h`, `fearGreed`, `sessionPnl`, `portfolio.positions`

**Files:** `src/risk/manager.ts`, `src/trading-loop.ts`

### 2.3 Position Age Auto-Exit

**Problem:** Positions hang for hours/days without progress. LLM often HOLDs indefinitely.

**Fix:** In `TradingLoop.runOnce()`, before LLM analysis:
- For each open position:
  - If held > `staleHours` (default 8) AND P&L between -1% and +1% → auto CLOSE
  - If held > `maxHoldHours` (default 24) → auto CLOSE regardless of P&L
- Configurable thresholds in `config.trading`
- Log as `{ type: 'AUTO_CLOSE', reason: 'stale_8h' | 'max_hold_24h' }`

**Files:** `src/trading-loop.ts`, `src/config.ts`

---

## 3. Enhanced Prompt Engineering

### 3.1 System Prompt Rewrite

Add explicit rules (soft — LLM CAN override with high confidence + reasoning):

```
MULTI-TIMEFRAME CONFIRMATION:
- LONG: Prefer if EMA20 > EMA50 on BOTH 1h AND 4h. If only 1h bullish, reduce leverage or wait.
- SHORT: Prefer if EMA20 < EMA50 on BOTH 1h AND 4h.
- 4h trend overrides 1h for direction. Use 1h for entry timing.

MARKET REGIME (adjust based on Fear & Greed):
- Extreme Fear (<25): Only highest-confluence setups. Expect capitulation wicks.
- Extreme Greed (>85): Expect mean reversion. Reduce size, prefer shorts.
- Normal: Standard rules apply.

VOLUME & LIQUIDITY:
- Volume > 2x 20-period avg: High conviction, full leverage OK
- Volume < 0.8x avg: Low conviction, reduce leverage 30%
- Order book >70% one-sided: Imbalanced, reduce size

FUNDING & OI:
- Funding < -0.05%: Crowded shorts, LONG opportunity if technicals confirm
- Funding trend rising: Longs adding confidence, follow momentum
- OI up >10% with price flat: Leverage buildup, risk of wick

POSITION MANAGEMENT:
- Position held >8h with <1% progress: Consider CLOSE (stale)
- Position held >24h: CLOSE unless strong conviction to hold (confidence >=80)
- After 2 consecutive losses: Reduce next trade size by 50%

CONFLUENCE CHECKLIST (need 3+ of 5 for entry):
1. EMA trend alignment (1h + 4h)
2. RSI in entry zone (40-65 for LONG, 35-60 for SHORT)
3. Price above/below VWAP (matching direction)
4. Volume > 1x average
5. News/macro catalyst (importance >= 5)
If <3 factors: HOLD or use minimal leverage (3-5x)

RISK SCALING:
- Report your confidence (1-100) for each decision
- If session P&L is negative: The system will automatically reduce your leverage
```

### 3.2 User Prompt Enrichment — Data Narratives

Replace raw numbers with interpreted narratives in `buildEnrichedPrompt()`:

**Volume narrative:**
```
VOLUME: 2.1x average — HIGH conviction move (bullish signal)
```

**VWAP positioning:**
```
Price 1.2% ABOVE VWAP — bullish intraday bias
```

**Bollinger Band alert:**
```
AT UPPER BAND (%B=92%) — overbought risk, watch for reversal
```

**Funding trend:**
```
Funding RISING: +0.001% → +0.003% → +0.005% (3 periods) — longs gaining confidence
```

**Trade performance analysis:**
```
## Trade Performance
Last 5 trades: 2W-3L | Avg win: $45 | Avg loss: $78
Current streak: 2 losses | Session P&L: -$45 (-2.3%)
WARNING: Losing streak — system will reduce leverage
```

**Files:** `src/llm/prompts.ts`

### 3.3 Pass Session State to LLM

Each cycle, LLM sees:
- `Session P&L: +$X (+Y%)`
- `Win/loss: 3W-2L today, streak: 1W`
- `Last order result: BTCUSDT LONG filled @ $67,500 — SL set, TP set`
- `Risk status: Normal | Reduced (losing streak) | Critical (>10% loss)`

**Files:** `src/llm/prompts.ts`, `src/trading-loop.ts`

---

## 4. Feedback Loop + Resilience

### 4.1 Order Execution Feedback

**Problem:** LLM doesn't know if its last order succeeded or failed.

**Fix:**
- After each execute: save result to `SessionMemory.lastOrderResult`
- Next cycle prompt includes: "Last order: BTCUSDT LONG — filled OK" or "Last order: ETHUSDT SHORT — FAILED (insufficient margin)"
- On failure: LLM told to adjust (lower size/leverage)

**Files:** `src/trading-loop.ts`, `src/memory/session.ts`, `src/llm/prompts.ts`

### 4.2 Parse Error Handling + Retry

- On JSON parse failure: log full response to `logs/parse-errors.jsonl`
- Retry once with prompt: "Your response was not valid JSON. Respond ONLY with the JSON object."
- If retry fails: return empty decisions, log to errors

**Files:** `src/llm/client.ts`

### 4.3 Fetch Timeouts

- `MacroFetcher.fetch()`: 15s timeout via `Promise.race`
- `CryptoPanicClient.fetchNews()`: 15s timeout
- `fetchFearGreed()`: 5s timeout
- On timeout: use cached data, log warning

**Files:** `src/news/macro-fetcher.ts`, `src/news/cryptopanic.ts`, `src/news/fear-greed.ts`

### 4.4 Churn Cooldown Persistence

- Persist `lastClosedAt` map to `~/.indic-bot/session-state.json`
- Load on startup so cooldowns survive restarts

**Files:** `src/trading-loop.ts`, `src/memory/session.ts`

---

## Data Flow (After Changes)

```
TradingLoop.runOnce()
  ├── MarketDataFetcher.getSnapshot() × 3 pairs
  ├── portfolioState (REAL from Binance) → sessionPnl = balance - startBalance
  ├── Auto-exit check: stale positions >8h, max hold >24h
  ├── [if stale 20min] CryptoPanicClient.fetchNews(timeout: 15s)
  │     └── NewsDB.insert() + NewsAnalyst.analyze()
  ├── [if stale 3h] MacroFetcher.fetch(timeout: 15s)
  │     └── MacroAnalyst.analyze()
  ├── Compute indicators 1h + 4h + 15m
  ├── buildEnrichedPrompt(
  │     snapshots, indicators, indicators4h,
  │     portfolio, recentNewsWithAge, macroAnalysis,
  │     fearGreed, sessionPnl, winLossStats,
  │     lastOrderResult, riskStatus
  │   )
  │   └── narratives: volume, VWAP, Bollinger, funding trend, trade analysis
  ├── LLMClient.analyze() → decisions with confidence
  │     ├── If parse fails: retry once
  │     └── TokenLogger.log()
  ├── RiskManager.validate(decision, portfolio, indicators4h, fearGreed, sessionPnl)
  │     ├── 4h confirmation check (confidence-aware)
  │     ├── Fear/Greed leverage cap
  │     ├── Session loss scaling
  │     ├── Duplicate position check
  │     └── Confidence threshold check
  └── OrderExecutor.execute()
        ├── Entry order
        ├── SL order (FAIL → close entry, return error)
        ├── TP order (FAIL → warn, keep position)
        └── Save result → SessionMemory.lastOrderResult
```

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/trading-loop.ts` | **MAJOR** — startBalance tracking, auto-exit, pass indicators4h/fearGreed to risk manager, order feedback |
| `src/risk/manager.ts` | **MAJOR** — 4h guardrails, F&G cap, session loss scaling, duplicate check, confidence threshold |
| `src/llm/prompts.ts` | **MAJOR** — system prompt rewrite, data narratives, session state in prompt |
| `src/llm/client.ts` | **MODIFY** — better JSON regex, retry on parse fail, parse-errors log |
| `src/binance/orders.ts` | **MODIFY** — SL failure → cancel trade |
| `src/config.ts` | **MODIFY** — add staleHours, maxHoldHours, minConfidence thresholds |
| `src/memory/session.ts` | **MODIFY** — lastOrderResult, winLossStats, startBalance persistence |
| `src/news/macro-fetcher.ts` | **MODIFY** — add fetch timeout |
| `src/news/cryptopanic.ts` | **MODIFY** — add fetch timeout |
| `src/news/fear-greed.ts` | **MODIFY** — add fetch timeout |

---

## After This: Project Documentation

After implementation, write comprehensive project docs:
- `docs/ARCHITECTURE.md` — idea, logic, data flow, strategy philosophy
- Update `CLAUDE.md` with new components and config options
