# ADJUST_FAIL Feedback + PARTIAL_CLOSE Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the ADJUST_FAIL silent loop (LLM repeats failed ADJUST every cycle without knowing it failed), and add PARTIAL_CLOSE action so the bot can intelligently bank profit without closing the whole position.

**Architecture:** Three layers of change — (1) in-memory ADJUST_FAIL tracker in TradingLoop that injects a warning into the LLM prompt, (2) updated prompt text that softens "DO NOT close" and adds PARTIAL_CLOSE guidelines, (3) new `PARTIAL_CLOSE` action in TradeDecision that calls the existing `orders.partialClose()` with limit or market order type. No new DB tables needed.

**Tech Stack:** TypeScript ESM, Vitest, existing `OrderExecutor.partialClose()` in `src/binance/orders.ts`

---

### Task 1: ADJUST_FAIL in-memory tracker + prompt injection

**Context:** Currently `trading-loop.ts:1575` logs `ADJUST_FAIL` to errors table but never feeds it back to LLM. `promptData` at line 881-918 is the object passed to `buildEnrichedPrompt()`. We need to track consecutive failures per pair and inject a warning block into the prompt.

**Files:**
- Modify: `src/trading-loop.ts` (add tracker field + failure recording + promptData injection)
- Modify: `src/llm/prompts.ts` (render the warning block)

**Step 1: Add tracker to TradingLoop class**

In `src/trading-loop.ts`, find the class field declarations (near `lastClosedAt`). Add:

```typescript
private adjustFailCount: Map<string, number> = new Map();
```

**Step 2: Record failure + clear on success**

In the ADJUST execution block (`src/trading-loop.ts:1545`), update:

```typescript
if (result.success) {
  this.adjustFailCount.delete(decision.pair); // clear on success
  // ... existing success code unchanged ...
} else {
  console.error(`[Adjust] Failed for ${decision.pair}: ${result.error}`);
  logger.logError('ADJUST_FAIL', result.error || 'Unknown');
  const prev = this.adjustFailCount.get(decision.pair) ?? 0;
  this.adjustFailCount.set(decision.pair, prev + 1);
}
```

Also clear on CLOSE/PARTIAL_CLOSE (add after `this.lastClosedAt.set(...)` in the CLOSE block):
```typescript
this.adjustFailCount.delete(decision.pair);
```

**Step 3: Build warnings and inject into promptData**

Just before the `promptData` object (around line 881), add:

```typescript
const adjustFailWarnings: string[] = [];
for (const [pair, count] of this.adjustFailCount.entries()) {
  if (count >= 2) {
    adjustFailWarnings.push(
      `${pair}: ADJUST failed ${count}x — "Order would immediately trigger". SL is already at market price. ADJUST is impossible. Valid actions: PARTIAL_CLOSE or CLOSE only.`
    );
  }
}
```

Add to `promptData`:
```typescript
adjustFailWarnings: adjustFailWarnings.length > 0 ? adjustFailWarnings : undefined,
```

**Step 4: Add `adjustFailWarnings` to prompt builder type**

In `src/llm/prompts.ts`, find the `PromptData` interface (around line 170-190). Add:
```typescript
adjustFailWarnings?: string[];
```

**Step 5: Render warning block in buildEnrichedPrompt**

In `src/llm/prompts.ts`, after the `filterWarning` block (around line 344), add:

```typescript
if (data.adjustFailWarnings?.length) {
  prompt += `\n>>> ⚠️ ADJUST BLOCKED ⚠️ <<<\n`;
  for (const w of data.adjustFailWarnings) {
    prompt += `${w}\n`;
  }
  prompt += `Do NOT output ADJUST for these pairs. Use PARTIAL_CLOSE or CLOSE instead.\n\n`;
}
```

**Step 6: Write tests**

In `tests/trading-loop.test.ts`, add a test verifying that after 2 failed ADJUSTs, `adjustFailWarnings` appears in the next prompt call. Use the existing mock pattern.

```typescript
it('injects adjustFailWarnings after 2 ADJUST failures', async () => {
  mockOrders.adjustSlTp = vi.fn().mockResolvedValue({ success: false, error: 'Order would immediately trigger' });
  mockLlm.analyze = vi.fn().mockResolvedValue([{
    pair: 'BTCUSDT', action: 'ADJUST', stop_loss_pct: 1, take_profit_pct: 6,
    size_pct: 30, leverage: 5, confidence: 80, reasoning: 'lock profit',
  }]);
  // Run 2 cycles
  await loop.runOnce();
  await loop.runOnce();
  // On 3rd cycle, check that the prompt contains the warning
  const callArg = mockLlm.analyze.mock.calls[2]?.[0] ?? '';
  expect(callArg).toContain('ADJUST BLOCKED');
  expect(callArg).toContain('BTCUSDT');
});
```

Run: `npx vitest run tests/trading-loop.test.ts -t "adjustFailWarnings"`
Expected: PASS

**Step 7: Commit**
```bash
git add src/trading-loop.ts src/llm/prompts.ts tests/trading-loop.test.ts
git commit -m "feat: inject ADJUST_FAIL warnings into LLM prompt after 2 failures"
```

---

### Task 2: Soften "DO NOT close" + add PARTIAL_CLOSE guidelines to prompt

**Context:** `src/llm/prompts.ts:653` has a hardcoded `>>> DO NOT close this position unless SL is hit or thesis is invalidated <<<`. This prevents the LLM from choosing CLOSE/PARTIAL_CLOSE when ADJUST is failing. Also need to add PARTIAL_CLOSE tier guidelines after the existing ADJUST tiers (lines 96-104).

**Files:**
- Modify: `src/llm/prompts.ts` (2 places)

**Step 1: Soften line 653**

Find:
```typescript
prompt += `    >>> DO NOT close this position unless SL is hit or thesis is invalidated <<<\n`;
```

Replace with:
```typescript
prompt += `    >>> Hold winners. CLOSE only if thesis invalidated, regime reversed, or ADJUST is blocked. PARTIAL_CLOSE is valid to bank profit. <<<\n`;
```

**Step 2: Add PARTIAL_CLOSE tiers after ADJUST tiers**

After line 104 (`- Negative stop_loss_pct = profit lock (SL beyond entry in profitable direction)`), add:

```typescript
`\nPARTIAL_CLOSE GUIDELINES (not mandatory — use judgment based on full context):
  * ROI 10–20%: closing 25% is valid | prefer limit order
  * ROI 20–40%: closing 50% is valid | limit if tape is quiet and L/S favors you, else market
  * ROI 40%+:   closing 75% is valid | market acceptable (vol risk outweighs slippage)
  Order type rules:
  - close_type "limit": quiet volume (<0.8x), L/S ratio favors your side, spread is tight
  - close_type "market": volume spike, regime changing, ADJUST blocked and price moving fast
  After partial close: remaining position keeps existing SL/TP. Do NOT re-ADJUST immediately.
  Use PARTIAL_CLOSE when ADJUST is blocked, momentum slowing, or to secure partial gains.
  Do NOT partial close just because ROI is high — if trend is strong and thesis holds, let it run.\n`
```

**Step 3: Run existing tests to confirm no regressions**

Run: `npx vitest run tests/llm/`
Expected: all PASS

**Step 4: Commit**
```bash
git add src/llm/prompts.ts
git commit -m "feat: soften DO NOT close rule, add PARTIAL_CLOSE guidelines to prompt"
```

---

### Task 3: Add PARTIAL_CLOSE to TradeDecision interface + JSON schema

**Context:** `src/risk/manager.ts:5` has `action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST'`. The LLM JSON schema in `src/llm/prompts.ts:111` also lists these actions. Need to add `PARTIAL_CLOSE` and two new optional fields: `close_pct` (25-75) and `close_type` ('limit'|'market').

**Files:**
- Modify: `src/risk/manager.ts:5`
- Modify: `src/llm/prompts.ts:111` (schema)

**Step 1: Extend TradeDecision interface**

In `src/risk/manager.ts`, find:
```typescript
action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST';
```

Replace with:
```typescript
action: 'LONG' | 'SHORT' | 'CLOSE' | 'PARTIAL_CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST';
close_pct?: number;       // for PARTIAL_CLOSE: 25-75
close_type?: 'limit' | 'market'; // for PARTIAL_CLOSE
```

**Step 2: Update JSON schema in prompts**

Find line 111:
```typescript
"action": "LONG" | "SHORT" | "CLOSE" | "HOLD" | "ADJUST",
```

Replace with:
```typescript
"action": "LONG" | "SHORT" | "CLOSE" | "PARTIAL_CLOSE" | "HOLD" | "ADJUST",
"close_pct": <25-75, only for PARTIAL_CLOSE>,
"close_type": "limit" | "market",  // only for PARTIAL_CLOSE
```

**Step 3: Update risk manager to pass through PARTIAL_CLOSE**

In `src/risk/manager.ts`, find where HOLD/CLOSE/ADJUST bypass risk checks. Look for the bypass comment/condition. Add `PARTIAL_CLOSE` alongside `CLOSE`:

```typescript
// HOLD, CLOSE, PARTIAL_CLOSE, FETCH_NEWS bypass all checks
if (['HOLD', 'CLOSE', 'PARTIAL_CLOSE', 'FETCH_NEWS'].includes(decision.action)) {
  return { passed: true };
}
```

**Step 4: Run type-check**

```bash
npx tsc --noEmit
```

Expected: no errors

**Step 5: Commit**
```bash
git add src/risk/manager.ts src/llm/prompts.ts
git commit -m "feat: add PARTIAL_CLOSE action to TradeDecision interface and JSON schema"
```

---

### Task 4: Execute PARTIAL_CLOSE in trading-loop + limit support

**Context:** `orders.partialClose()` at `src/binance/orders.ts:246` already exists but only supports MARKET. We need to: (1) extend it to optionally accept a `limitPrice`, (2) handle `PARTIAL_CLOSE` in `trading-loop.ts` alongside the CLOSE block.

**Files:**
- Modify: `src/binance/orders.ts:246`
- Modify: `src/trading-loop.ts` (add PARTIAL_CLOSE execution block)

**Step 1: Extend partialClose() to support limit**

In `src/binance/orders.ts`, replace the `partialClose` signature and body:

```typescript
async partialClose(
  pair: string,
  side: 'LONG' | 'SHORT',
  ratio: number,
  limitPrice?: number,   // if set → LIMIT order, else MARKET
): Promise<OrderResult> {
  try {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const positions = await this.client.getPositions({ symbol: pair });
    const pos = positions.find((p: any) => p.symbol === pair && parseFloat(p.positionAmt) !== 0);
    if (!pos) return { success: false, error: `No open position found for ${pair}` };

    const fullQty = Math.abs(parseFloat(pos.positionAmt));
    const partialQty = this.roundQuantity(fullQty * ratio, pair);
    if (partialQty <= 0) return { success: false, error: `Partial quantity too small for ${pair}` };

    if (limitPrice) {
      const price = this.formatPrice(limitPrice, pair);
      try {
        const order = await this.client.submitNewOrder({
          symbol: pair, side: closeSide, type: 'LIMIT',
          price, quantity: String(partialQty),
          reduceOnly: 'true', timeInForce: 'GTC',
        });
        console.log(`[Orders] Partial close LIMIT ${pair} ${side}: ${(ratio * 100).toFixed(0)}% @ $${price}`);
        return { success: true, orderId: order.orderId, quantity: partialQty, fillPrice: limitPrice };
      } catch (limitErr: any) {
        console.warn(`[Orders] Partial close LIMIT failed for ${pair}, falling back to MARKET: ${limitErr.message}`);
        // fall through to MARKET
      }
    }

    const order = await this.client.submitNewOrder({
      symbol: pair, side: closeSide, type: 'MARKET',
      quantity: String(partialQty), reduceOnly: 'true',
    });
    console.log(`[Orders] Partial close MARKET ${pair} ${side}: ${(ratio * 100).toFixed(0)}% (${partialQty})`);
    return { success: true, orderId: order.orderId, quantity: partialQty };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
```

**Step 2: Add PARTIAL_CLOSE handler in trading-loop**

In `src/trading-loop.ts`, after the CLOSE block (around line 1510), add:

```typescript
} else if (decision.action === 'PARTIAL_CLOSE') {
  const pos = portfolio.positions.find((p) => p.pair === decision.pair);
  if (!pos) {
    console.log(`[PartialClose] No open position for ${decision.pair} — skipping`);
    continue;
  }
  const ratio = Math.min(Math.max((decision.close_pct ?? 50) / 100, 0.1), 0.9);

  // Compute limit price if requested: mid-price + small offset toward close side
  let limitPrice: number | undefined;
  if (decision.close_type === 'limit') {
    const snap = filteredSnapshots.find(s => s.pair === decision.pair);
    const markPrice = parseFloat(snap?.markPrice ?? '0');
    if (markPrice > 0) {
      // LONG close = sell above market; SHORT close = buy below market
      const offsetPct = 0.05 / 100;
      limitPrice = pos.side === 'LONG'
        ? markPrice * (1 + offsetPct)
        : markPrice * (1 - offsetPct);
    }
  }

  const result = await orders.partialClose(decision.pair, pos.side, ratio, limitPrice);
  if (result.success) {
    console.log(`[PartialClose] ${decision.pair}: closed ${(ratio * 100).toFixed(0)}% (${decision.close_type ?? 'market'})`);
    this.adjustFailCount.delete(decision.pair);
    this.deps.memory.setLastOrderResult(
      `${decision.pair} PARTIAL_CLOSE ${(ratio * 100).toFixed(0)}% ${decision.close_type ?? 'market'}: ${decision.reasoning}`
    );
    // DB: log as a partial close event
    if (cycleId) {
      const posCtxForClose = positionContexts.find(c => c.pair === decision.pair);
      const pnlUsd = pos.unrealizedPnlPct * (pos.sizeUsd / pos.leverage) / 100 * ratio;
      insertTradeClose({
        execution_id: posCtxForClose?.id,
        pair: decision.pair,
        exit_reason: `partial_close_${(ratio * 100).toFixed(0)}pct`,
        pnl_usd: parseFloat(pnlUsd.toFixed(2)),
        pnl_pct: pos.unrealizedPnlPct * ratio,
        regime_at_exit: marketRegime?.regime,
      }).catch(() => {});
    }
  } else {
    console.error(`[PartialClose] Failed for ${decision.pair}: ${result.error}`);
    logger.logError('PARTIAL_CLOSE_FAIL', result.error || 'Unknown');
  }
```

**Step 3: Write test for PARTIAL_CLOSE execution**

In `tests/trading-loop.test.ts`:

```typescript
it('executes PARTIAL_CLOSE with market order', async () => {
  mockOrders.partialClose = vi.fn().mockResolvedValue({ success: true, orderId: 999, quantity: 100 });
  mockLlm.analyze = vi.fn().mockResolvedValue([{
    pair: 'BTCUSDT', action: 'PARTIAL_CLOSE', close_pct: 50, close_type: 'market',
    size_pct: 0, leverage: 1, stop_loss_pct: 2, take_profit_pct: 6,
    confidence: 80, reasoning: 'take partial profit',
  }]);
  // mock portfolio with open position
  mockMarketData.getPortfolioState = vi.fn().mockResolvedValue({
    balanceUsd: 100, positions: [{ pair: 'BTCUSDT', side: 'LONG', sizeUsd: 50, leverage: 5, unrealizedPnlPct: 22 }],
    sessionPnl: 0, drawdownPct: 0,
  });
  await loop.runOnce();
  expect(mockOrders.partialClose).toHaveBeenCalledWith('BTCUSDT', 'LONG', 0.5, undefined);
});
```

Run: `npx vitest run tests/trading-loop.test.ts -t "PARTIAL_CLOSE"`
Expected: PASS

**Step 4: Run all tests**

```bash
npx vitest run
```

Expected: all PASS

**Step 5: Commit**
```bash
git add src/binance/orders.ts src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: execute PARTIAL_CLOSE with limit/market support and DB logging"
```

---

### Task 5: Deploy

**Step 1: Build**
```bash
npm run build
```
Expected: no TypeScript errors

**Step 2: Deploy to GCP VM**
```bash
npm run deploy
```

**Step 3: Verify on VM**
```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 "pm2 logs indic-bot --lines 30 --nostream"
```
Expected: no startup errors, bot running

**Step 4: Commit deploy**
```bash
git add -A
git commit -m "deploy: ADJUST_FAIL feedback + PARTIAL_CLOSE action"
```
