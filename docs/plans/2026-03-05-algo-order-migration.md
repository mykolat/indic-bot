# Binance Algo Order Migration — Hotfix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate SL/TP order placement from deprecated `submitNewOrder(STOP_MARKET)` to new `submitNewAlgoOrder(CONDITIONAL)` endpoint, and add `cancelAllAlgoOpenOrders` to `close()` to prevent orphaned SL/TP orders.

**Architecture:** Replace two `submitNewOrder` calls (SL + TP) in `execute()` with `submitNewAlgoOrder`. Add `cancelAllAlgoOpenOrders` call in `close()` before the market close order. The entry MARKET order and close MARKET order stay on the old endpoint — only conditional orders moved.

**Tech Stack:** `binance` npm v3.4.3 (`USDMClient.submitNewAlgoOrder`, `cancelAllAlgoOpenOrders`), Vitest

---

## Context

Binance migrated all conditional orders (STOP_MARKET, TAKE_PROFIT_MARKET, etc.) to the Algo Order API as of 2025-12-09. The old `fapi/v1/order` endpoint now rejects these types with error -4120. Our bot opens positions, fails to place SL, emergency-closes — burning commissions every cycle.

**Key API differences:**

| Old (`submitNewOrder`)  | New (`submitNewAlgoOrder`)         |
|-------------------------|------------------------------------|
| `stopPrice`             | `triggerPrice`                     |
| no `algoType`           | `algoType: 'CONDITIONAL'` required |
| returns `orderId`       | returns `algoId`                   |
| cancel: `cancelOrder`   | cancel: `cancelAlgoOrder`          |

**Bot is STOPPED on GCP.** Do not restart until all tasks are complete and tests pass.

---

### Task 1: Update tests for Algo Order SL/TP in `execute()`

**Files:**
- Modify: `tests/binance/orders.test.ts`

**Step 1: Add `submitNewAlgoOrder` mock to `beforeEach`**

In `beforeEach`, add the new mock alongside existing `submitNewOrder`:

```typescript
submitNewAlgoOrder: vi.fn().mockResolvedValue({
  algoId: 789,
  clientAlgoId: '',
  algoType: 'CONDITIONAL',
  orderType: 'STOP_MARKET',
  symbol: 'BTCUSDT',
  side: 'SELL',
  algoStatus: 'NEW',
}),
```

**Step 2: Update test "opens a LONG position with market order + stop-loss + take-profit"**

Change assertions — `submitNewOrder` should now be called only **1 time** (entry MARKET), while `submitNewAlgoOrder` should be called **2 times** (SL + TP):

```typescript
it('opens a LONG position with market order + stop-loss + take-profit', async () => {
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };

  const result = await executor.execute(decision, 10);

  expect(mockClient.setLeverage).toHaveBeenCalledWith({ symbol: 'BTCUSDT', leverage: 10 });
  expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1); // only entry
  expect(mockClient.submitNewAlgoOrder).toHaveBeenCalledTimes(2); // SL + TP
  expect(result.success).toBe(true);

  const stopCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
  expect(stopCall.algoType).toBe('CONDITIONAL');
  expect(stopCall.type).toBe('STOP_MARKET');
  expect(stopCall.triggerPrice).toBeDefined();
  expect(stopCall.closePosition).toBe('true');

  const tpCall = mockClient.submitNewAlgoOrder.mock.calls[1][0];
  expect(tpCall.algoType).toBe('CONDITIONAL');
  expect(tpCall.type).toBe('TAKE_PROFIT_MARKET');
  expect(tpCall.triggerPrice).toBeDefined();
  expect(tpCall.closePosition).toBe('true');
});
```

**Step 3: Update test "stop price is below entry for LONG, above for SHORT"**

Change `stopPrice` references to `triggerPrice`, and read from `submitNewAlgoOrder` mock calls instead of `submitNewOrder`:

```typescript
it('trigger price is below entry for LONG, above for SHORT', async () => {
  const longDecision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };
  await executor.execute(longDecision, 10);
  const stopCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
  expect(parseFloat(stopCall.triggerPrice)).toBeLessThan(50000);

  mockClient.submitNewAlgoOrder.mockClear();
  mockClient.submitNewOrder.mockClear();

  const shortDecision: TradeDecision = {
    pair: 'BTCUSDT', action: 'SHORT', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };
  await executor.execute(shortDecision, 10);
  const shortStopCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
  expect(parseFloat(shortStopCall.triggerPrice)).toBeGreaterThan(50000);
});
```

**Step 4: Update test "take-profit price is above entry for LONG"**

```typescript
it('take-profit price is above entry for LONG', async () => {
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };
  await executor.execute(decision, 10);
  const tpCall = mockClient.submitNewAlgoOrder.mock.calls[1][0];
  expect(parseFloat(tpCall.triggerPrice)).toBeGreaterThan(50000);
});
```

**Step 5: Update test "closes position if SL placement fails"**

SL now uses `submitNewAlgoOrder`, so the failure mock goes there. `submitNewOrder` stays for entry + emergency close (2 calls). `submitNewAlgoOrder` gets 1 call (SL fail):

```typescript
it('closes position if SL placement fails', async () => {
  mockClient.submitNewAlgoOrder = vi.fn().mockRejectedValue(new Error('SL rejected'));

  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10,
    leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test',
  };

  const result = await executor.execute(decision, 10000);

  expect(result.success).toBe(false);
  expect(result.error).toContain('SL');
  expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(2); // entry + emergency close
  expect(mockClient.submitNewAlgoOrder).toHaveBeenCalledTimes(1); // SL attempt
});
```

**Step 6: Update test "succeeds if only TP fails (SL is set)"**

```typescript
it('succeeds if only TP fails (SL is set)', async () => {
  let algoCallCount = 0;
  mockClient.submitNewAlgoOrder = vi.fn().mockImplementation(async () => {
    algoCallCount++;
    if (algoCallCount === 1) return { algoId: 1 }; // SL OK
    throw new Error('TP rejected'); // TP fails
  });

  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10,
    leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test',
  };

  const result = await executor.execute(decision, 10000);

  expect(result.success).toBe(true); // TP failure is non-fatal
});
```

**Step 7: Run tests to verify they fail**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: FAIL — implementation still uses old `submitNewOrder` for SL/TP

---

### Task 2: Migrate `execute()` SL/TP to Algo Orders

**Files:**
- Modify: `src/binance/orders.ts:56-94`

**Step 1: Replace SL placement (lines 56-82)**

Replace the SL `submitNewOrder` call with `submitNewAlgoOrder`:

```typescript
// Stop-Loss (MANDATORY — fail = cancel trade)
try {
  await this.client.submitNewAlgoOrder({
    algoType: 'CONDITIONAL',
    symbol: decision.pair,
    side: closeSide,
    type: 'STOP_MARKET',
    triggerPrice: String(this.roundPrice(stopPrice)),
    closePosition: 'true',
  });
} catch (slErr: any) {
```

The rest of the SL failure handler (lines 64-82) stays exactly the same — it uses `submitNewOrder(MARKET)` which is correct.

**Step 2: Replace TP placement (lines 84-94)**

```typescript
try {
  await this.client.submitNewAlgoOrder({
    algoType: 'CONDITIONAL',
    symbol: decision.pair,
    side: closeSide,
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: String(this.roundPrice(tpPrice)),
    closePosition: 'true',
  });
} catch (tpErr: any) {
  console.error(`[Orders] TP placement failed for ${decision.pair}: ${tpErr.message}`);
}
```

**Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "fix: migrate SL/TP to Binance Algo Order API

Binance deprecated STOP_MARKET/TAKE_PROFIT_MARKET on fapi/v1/order
endpoint (error -4120). Migrate to submitNewAlgoOrder with
algoType: 'CONDITIONAL' and triggerPrice (replaces stopPrice)."
```

---

### Task 3: Add cancel algo orders to `close()`

**Files:**
- Modify: `tests/binance/orders.test.ts`
- Modify: `src/binance/orders.ts:102-125`

**Step 1: Add `cancelAllAlgoOpenOrders` mock to `beforeEach`**

```typescript
cancelAllAlgoOpenOrders: vi.fn().mockResolvedValue({ code: '000000', msg: 'success' }),
```

**Step 2: Write failing test — close cancels algo orders before closing**

Add new test:

```typescript
it('cancels algo orders before closing position', async () => {
  const result = await executor.close('BTCUSDT', 'LONG');
  expect(mockClient.cancelAllAlgoOpenOrders).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
  expect(mockClient.cancelAllAlgoOpenOrders).toHaveBeenCalledBefore(mockClient.submitNewOrder);
  expect(result.success).toBe(true);
});
```

**Step 3: Write failing test — close succeeds even if cancel algo fails**

```typescript
it('closes position even if cancel algo orders fails', async () => {
  mockClient.cancelAllAlgoOpenOrders = vi.fn().mockRejectedValue(new Error('no algo orders'));

  const result = await executor.close('BTCUSDT', 'LONG');
  expect(result.success).toBe(true);
  expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1);
});
```

**Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: FAIL — `cancelAllAlgoOpenOrders` never called

**Step 5: Add cancel to `close()` implementation**

Replace the `close()` method:

```typescript
async close(pair: string, side: 'LONG' | 'SHORT'): Promise<OrderResult> {
  try {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

    // Cancel any existing algo orders (SL/TP) before closing
    try {
      await this.client.cancelAllAlgoOpenOrders({ symbol: pair });
    } catch {
      // No algo orders to cancel — that's fine
    }

    // Fetch exact position size from Binance to avoid precision errors
    const positions = await this.client.getPositions({ symbol: pair });
    const pos = positions.find((p: any) => p.symbol === pair && parseFloat(p.positionAmt) !== 0);
    if (!pos) {
      return { success: false, error: `No open position found for ${pair}` };
    }
    const quantity = Math.abs(parseFloat(pos.positionAmt));

    const order = await this.client.submitNewOrder({
      symbol: pair,
      side: closeSide,
      type: 'MARKET',
      quantity: String(quantity),
      reduceOnly: 'true',
    });
    return { success: true, orderId: order.orderId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: ALL PASS

**Step 7: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 8: Commit**

```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "fix: cancel algo orders before closing positions

Without this, orphaned SL/TP algo orders could trigger on
future positions for the same symbol."
```

---

### Task 4: Deploy and verify

**Step 1: Build to catch type errors**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Deploy to GCP**

Run: `npm run deploy`

**Step 3: Start bot**

Run: `ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'cd ~/indic-bot && pm2 restart indic-bot'`

**Step 4: Watch logs for first cycle**

Run: `ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'pm2 logs indic-bot --lines 50'`

Expected: No more "Order type not supported for this endpoint" errors. If LLM decides to trade, SL/TP should place successfully via algo orders.

**Step 5: Verify no SL failure loop**

After ~5 minutes, check errors log:

Run: `ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'tail -5 ~/indic-bot/logs/errors.jsonl'`

Expected: No new `ORDER_FAIL` entries with "Algo Order API" message.
