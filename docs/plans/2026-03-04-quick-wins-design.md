# Quick Wins Design — sessionPnl fix, 4h indicators, trade memory

**Date:** 2026-03-04
**Goal:** Three independent low-effort high-value improvements.

---

## 1. Fix sessionPnl tracking

**Problem:** `sessionPnl` is always 0. Risk shutdown trigger never fires.

**Fix:** After successful CLOSE, find position in `portfolio.positions`, compute P&L, add to `this.sessionPnl`:
```
pnl = position.unrealizedPnlPct * position.sizeUsd / 100
this.sessionPnl += pnl
```

**Files:** `src/trading-loop.ts`

---

## 2. 4h indicators in LLM prompt

**Problem:** 4h candles are fetched but indicators never computed — LLM has no higher-timeframe context.

**Fix:** Compute `computeIndicators(closes4h, highs4h, lows4h)` alongside existing 1h indicators. Pass `ind4h` into prompt:
```
4h trend: bullish | RSI(14) 4h: 62.4 | EMA20 4h: $71200 | ATR 4h: $1400
```

**Files:** `src/trading-loop.ts` (compute), `src/llm/prompts.ts` (show), `src/llm/prompts.ts` (EnrichedPromptData type)

---

## 3. Trade history → session memory

**Problem:** `memory.addTrade()` interface exists but is never called after CLOSE. LLM's "Recent Closed Trades" section is always empty.

**Fix:** After successful CLOSE with known P&L, call:
```typescript
deps.memory.addTrade({
  pair, action: 'CLOSE', pnlUsd, pnlPct,
  closedAt: new Date().toISOString(),
})
```

**Files:** `src/trading-loop.ts`

---

## Architecture

All three tasks touch `trading-loop.ts` (Tasks 1 & 3 in the CLOSE block, Task 2 in the indicators block). Task 2 also touches `prompts.ts`. All are independent of each other.

No new API calls. No new dependencies. No new files (except test additions).
