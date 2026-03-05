# Quick Wins Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Three independent improvements: fix `sessionPnl` accumulation, add 4h indicators to LLM prompt, record closed trades to session memory.

**Architecture:** All changes are in `src/trading-loop.ts` (CLOSE block for Tasks 1 & 3, indicators block for Task 2) and `src/llm/prompts.ts` + `EnrichedPromptData` type for Task 2. No new files, no new API calls.

**Tech Stack:** TypeScript ESM, Vitest, existing `computeIndicators`, `SessionMemory.addTrade`

---

### Task 1: Fix sessionPnl — accumulate P&L after CLOSE

**Files:**
- Modify: `src/trading-loop.ts:163-173` (CLOSE success block)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**

Add to `tests/trading-loop.test.ts` inside `describe('TradingLoop', ...)`:

```typescript
it('accumulates sessionPnl after successful CLOSE', async () => {
  mockLlm.analyze.mockResolvedValueOnce([
    { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 1, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'exit' },
  ]);
  mockMarketData.getPortfolioState.mockResolvedValueOnce({
    balanceUsd: 1000,
    positions: [{
      pair: 'BTCUSDT', side: 'LONG',
      sizeUsd: 100, leverage: 5,
      entryPrice: 50000, unrealizedPnlPct: 8, heldHours: 2,
    }],
    sessionPnl: 0,
  });
  mockOrders.close.mockResolvedValueOnce({ success: true, orderId: 99 });

  await loop.runOnce();

  // sessionPnl passed to logPerformance should reflect the closed trade
  const perfCall = mockLogger.logPerformance.mock.calls[0][0];
  expect(perfCall.sessionPnl).toBeCloseTo(8); // 8% of $100 sizeUsd
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/mykolat/Documents/Projects/00_Amikus/04_Indic
npx vitest run tests/trading-loop.test.ts 2>&1 | tail -20
```

Expected: FAIL — `expect(received).toBeCloseTo(8)` — received `0`

**Step 3: Implement in `src/trading-loop.ts`**

Find the CLOSE success block (lines 167-169):
```typescript
if (result.success) {
  logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
  this.lastClosedAt.set(decision.pair, Date.now());
}
```

Replace with:
```typescript
if (result.success) {
  const pnlUsd = pos.unrealizedPnlPct * pos.sizeUsd / 100;
  this.sessionPnl += pnlUsd;
  logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
  this.lastClosedAt.set(decision.pair, Date.now());
}
```

**Step 4: Run tests to verify pass**

```bash
npx vitest run tests/trading-loop.test.ts 2>&1 | tail -10
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add tests/trading-loop.test.ts src/trading-loop.ts
git commit -m "fix: accumulate sessionPnl after successful CLOSE"
```

---

### Task 2: 4h indicators in LLM prompt

**Files:**
- Modify: `src/trading-loop.ts:80-88` (indicators computation block)
- Modify: `src/llm/prompts.ts:61-71` (EnrichedPromptData type)
- Modify: `src/llm/prompts.ts:100-160` (buildEnrichedPrompt — add 4h line)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**

Add to `tests/trading-loop.test.ts`:

```typescript
it('computes and passes 4h indicators to llm.analyze', async () => {
  // Provide realistic 4h candles (need ≥ 50 for computeIndicators)
  const make4hCandles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      openTime: i, open: '50000', high: '51000', low: '49000',
      close: String(50000 + i * 10), volume: '100',
    }));

  mockMarketData.getSnapshot.mockResolvedValueOnce({
    pair: 'BTCUSDT',
    candles1h: [],
    candles4h: make4hCandles(50),
    candles15m: [],
    fundingRate: '0.0001', fundingHistory: [],
    openInterest: '80000', markPrice: '50000',
    longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
  });

  await loop.runOnce();

  const callArg = mockLlm.analyze.mock.calls[0][0];
  expect(callArg.indicators4h).toBeDefined();
  expect(callArg.indicators4h.has('BTCUSDT')).toBe(true);
  const ind4h = callArg.indicators4h.get('BTCUSDT');
  expect(typeof ind4h.rsi).toBe('number');
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/trading-loop.test.ts -t "4h indicators" 2>&1 | tail -15
```

Expected: FAIL — `callArg.indicators4h` is `undefined`

**Step 3: Add `indicators4h` to `EnrichedPromptData` in `src/llm/prompts.ts`**

Find (line ~61):
```typescript
export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
```

Add `indicators4h` field after `indicators`:
```typescript
export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
  indicators4h?: Map<string, Indicators>;
```

**Step 4: Compute indicators4h in `src/trading-loop.ts`**

After the existing indicators loop (after line 88), add:

```typescript
// Compute 4h indicators for each pair
const indicators4h = new Map<string, Indicators>();
for (const snap of snapshots) {
  if (snap.candles4h.length >= 20) {
    const closes4h = snap.candles4h.map(c => parseFloat(c.close));
    const highs4h = snap.candles4h.map(c => parseFloat(c.high));
    const lows4h = snap.candles4h.map(c => parseFloat(c.low));
    const volumes4h = snap.candles4h.map(c => parseFloat(c.volume));
    indicators4h.set(snap.pair, computeIndicators(closes4h, highs4h, lows4h, volumes4h));
  }
}
```

Then pass it to `llm.analyze()` — find the `llm.analyze({...})` call and add `indicators4h`:
```typescript
const decisions = await llm.analyze({
  snapshots,
  indicators,
  indicators4h,
  portfolio,
  ...
```

**Step 5: Show 4h indicators in `buildEnrichedPrompt` in `src/llm/prompts.ts`**

In `buildEnrichedPrompt`, after the 1h Bollinger line (after the `if (ind)` block), add:

```typescript
// 4h indicators
const ind4h = data.indicators4h?.get(snap.pair);
if (ind4h) {
  prompt += `4h trend: ${ind4h.trend} | RSI(14) 4h: ${ind4h.rsi.toFixed(1)} | EMA20 4h: $${ind4h.ema20.toFixed(2)} | ATR 4h: $${ind4h.atr.toFixed(2)}\n`;
}
```

**Step 6: Run all tests**

```bash
npx vitest run 2>&1 | tail -15
```

Expected: all tests PASS (tsc clean too: `npx tsc --noEmit`)

**Step 7: Commit**

```bash
git add src/trading-loop.ts src/llm/prompts.ts tests/trading-loop.test.ts
git commit -m "feat: compute and display 4h indicators in LLM prompt"
```

---

### Task 3: Record closed trades to session memory

> Depends on Task 1 — `pnlUsd` variable must already exist in the CLOSE block.

**Files:**
- Modify: `src/trading-loop.ts:163-173` (CLOSE success block)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**

Add to `tests/trading-loop.test.ts`:

```typescript
it('records closed trade to memory after successful CLOSE', async () => {
  mockLlm.analyze.mockResolvedValueOnce([
    { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 1, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'exit' },
  ]);
  mockMarketData.getPortfolioState.mockResolvedValueOnce({
    balanceUsd: 1000,
    positions: [{
      pair: 'BTCUSDT', side: 'LONG',
      sizeUsd: 100, leverage: 5,
      entryPrice: 50000, unrealizedPnlPct: 5, heldHours: 2,
    }],
    sessionPnl: 0,
  });
  mockOrders.close.mockResolvedValueOnce({ success: true, orderId: 99 });

  const mockMemory = loop['deps'].memory as any;
  mockMemory.addTrade.mockClear();

  await loop.runOnce();

  expect(mockMemory.addTrade).toHaveBeenCalledOnce();
  const tradeArg = mockMemory.addTrade.mock.calls[0][0];
  expect(tradeArg.pair).toBe('BTCUSDT');
  expect(tradeArg.action).toBe('CLOSE');
  expect(tradeArg.pnlPct).toBe(5);
  expect(tradeArg.pnlUsd).toBeCloseTo(5); // 5% of $100
  expect(typeof tradeArg.closedAt).toBe('string');
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/trading-loop.test.ts -t "records closed trade" 2>&1 | tail -15
```

Expected: FAIL — `addTrade` not called

**Step 3: Implement in `src/trading-loop.ts`**

In the CLOSE success block (after Task 1, which now has `pnlUsd`):

```typescript
if (result.success) {
  const pnlUsd = pos.unrealizedPnlPct * pos.sizeUsd / 100;
  this.sessionPnl += pnlUsd;
  logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
  this.lastClosedAt.set(decision.pair, Date.now());
  this.deps.memory.addTrade({
    pair: decision.pair,
    action: 'CLOSE',
    pnlUsd: parseFloat(pnlUsd.toFixed(2)),
    pnlPct: pos.unrealizedPnlPct,
    closedAt: new Date().toISOString(),
  });
}
```

**Step 4: Run all tests**

```bash
npx vitest run 2>&1 | tail -15
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: record closed trade to session memory"
```

---

### Final verification

```bash
npx vitest run 2>&1 | tail -5
npx tsc --noEmit 2>&1
```

Both must produce zero errors before merging.
