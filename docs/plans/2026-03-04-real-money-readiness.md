# Real Money Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 critical issues before trading real $50: broken stop-loss orders, LLM churn (rapid open/close same pair), and static MAX_LOSS_USD that doesn't scale with account size. Add automatic take-profit orders.

**Architecture:** All 3 tasks are independent and touch different files — Task 1 fixes `orders.ts` (stop-loss + take-profit orders), Task 2 adds cooldown map to `trading-loop.ts` + config, Task 3 changes risk threshold calculation in `risk/manager.ts` + config. Can all run in parallel.

**Tech Stack:** TypeScript, Binance Futures API (USDS-M), existing test suite (vitest)

---

## Context

Key existing files:
- `src/binance/orders.ts` — `execute()` places MARKET + STOP_MARKET. STOP_MARKET with `closePosition:'true'` fails on testnet with "Order type not supported". Fix: use `quantity + reduceOnly:'true'` instead.
- `src/trading-loop.ts` — calls `orders.execute()` and `orders.close()` in decision loop. No cooldown between trades.
- `src/risk/manager.ts` — `validate()` checks `portfolio.sessionPnl <= -maxLossUsd`. `maxLossUsd` is a fixed number from config.
- `src/config.ts` — `trading.maxLossUsd` from `MAX_LOSS_USD` env var (currently $5 on $5000 testnet = 0.1%)

Run tests: `npx vitest run tests/`
TypeScript check: `npx tsc --noEmit`

---

### Task 1: Fix stop-loss + add take-profit in `src/binance/orders.ts`

**Files:**
- Modify: `src/binance/orders.ts`
- Modify: `tests/binance/orders.test.ts`

**What's broken:** `STOP_MARKET` with `closePosition: 'true'` fails on demo-fapi testnet. Fix: pass explicit `quantity` + `reduceOnly: 'true'` (same as `close()` method). Also add `TAKE_PROFIT_MARKET` order so positions close automatically at target — currently there is NO take-profit order at all.

**Step 1: Update test — expect 3 submitNewOrder calls (market + stop + take-profit)**

In `tests/binance/orders.test.ts`, update the existing LONG test and add new assertions:

```typescript
it('opens a LONG position with market order + stop-loss + take-profit', async () => {
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };

  const result = await executor.execute(decision, 10);

  expect(mockClient.setLeverage).toHaveBeenCalledWith({ symbol: 'BTCUSDT', leverage: 10 });
  expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(3); // market + stop + take-profit
  expect(result.success).toBe(true);

  const stopCall = mockClient.submitNewOrder.mock.calls[1][0];
  expect(stopCall.type).toBe('STOP_MARKET');
  expect(stopCall.reduceOnly).toBe('true');
  expect(stopCall.closePosition).toBeUndefined(); // must NOT use closePosition

  const tpCall = mockClient.submitNewOrder.mock.calls[2][0];
  expect(tpCall.type).toBe('TAKE_PROFIT_MARKET');
  expect(tpCall.reduceOnly).toBe('true');
  expect(tpCall.closePosition).toBeUndefined();
});

it('stop price is below entry for LONG, above for SHORT', async () => {
  // LONG: entry $50000, stop_loss 2% → stopPrice = 50000 * 0.98 = 49000
  const longDecision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };
  await executor.execute(longDecision, 10);
  const stopCall = mockClient.submitNewOrder.mock.calls[1][0];
  expect(parseFloat(stopCall.stopPrice)).toBeLessThan(50000);

  mockClient.submitNewOrder.mockClear();

  // SHORT: entry $50000, stop_loss 2% → stopPrice = 50000 * 1.02 = 51000
  const shortDecision: TradeDecision = {
    pair: 'BTCUSDT', action: 'SHORT', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };
  await executor.execute(shortDecision, 10);
  const shortStopCall = mockClient.submitNewOrder.mock.calls[1][0];
  expect(parseFloat(shortStopCall.stopPrice)).toBeGreaterThan(50000);
});

it('take-profit price is above entry for LONG, below for SHORT', async () => {
  // LONG: entry $50000, take_profit 4% → tpPrice = 50000 * 1.04 = 52000
  const longDecision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };
  await executor.execute(longDecision, 10);
  const tpCall = mockClient.submitNewOrder.mock.calls[2][0];
  expect(parseFloat(tpCall.stopPrice)).toBeGreaterThan(50000);
});
```

**Step 2: Run to verify failure**
```bash
npx vitest run tests/binance/orders.test.ts
```
Expected: FAIL — `toHaveBeenCalledTimes(3)` fails (currently 2 calls)

**Step 3: Implement fix in `src/binance/orders.ts`**

Replace the stop-loss block in `execute()` (lines 31–42) with:

```typescript
      const stopPrice = decision.action === 'LONG'
        ? price * (1 - decision.stop_loss_pct / 100)
        : price * (1 + decision.stop_loss_pct / 100);

      const tpPrice = decision.action === 'LONG'
        ? price * (1 + decision.take_profit_pct / 100)
        : price * (1 - decision.take_profit_pct / 100);

      // Use quantity + reduceOnly (closePosition:'true' fails on demo-fapi testnet)
      await this.client.submitNewOrder({
        symbol: decision.pair,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: String(this.roundPrice(stopPrice)),
        quantity: String(quantity),
        reduceOnly: 'true',
      });

      await this.client.submitNewOrder({
        symbol: decision.pair,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: String(this.roundPrice(tpPrice)),
        quantity: String(quantity),
        reduceOnly: 'true',
      });
```

**Step 4: Run tests**
```bash
npx vitest run tests/binance/orders.test.ts
```
Expected: all pass

**Step 5: Run full suite + TypeScript check**
```bash
npx vitest run tests/ && npx tsc --noEmit
```
Expected: all pass, 0 errors

**Step 6: Commit**
```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "fix: use quantity+reduceOnly for stop-loss and add take-profit order"
```

---

### Task 2: Anti-churn cooldown in `src/trading-loop.ts` + config

**Files:**
- Modify: `src/config.ts`
- Modify: `src/trading-loop.ts`
- Modify: `tests/trading-loop.test.ts`

**What's broken:** LLM opened/closed SOL 10+ times in 5 minutes, losing ~$369 in fees. Fix: track last close time per pair; skip LONG/SHORT for that pair if closed within `CHURN_COOLDOWN_MS` (default 15 min).

**Step 1: Add config field**

In `src/config.ts`, add to `Config` interface `trading` section:
```typescript
    churnCooldownMs: number;
```

Add to `loadConfig()` `trading` section:
```typescript
      churnCooldownMs: parseInt(process.env.CHURN_COOLDOWN_MS || '900000', 10), // 15 min
```

**Step 2: Write failing test in `tests/trading-loop.test.ts`**

Read the file first. Add to `newsConfig` mock: `churnCooldownMs: 900000`.

Add a new test after existing tests:
```typescript
  it('skips LONG/SHORT within cooldown period after closing same pair', async () => {
    // First cycle: CLOSE a position (records close time)
    mockLlm.analyze.mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 1, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'exit' },
    ]);
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 10,
      positions: [{ pair: 'BTCUSDT', side: 'LONG', sizeUsd: 5, leverage: 5, entryPrice: 50000, unrealizedPnlPct: 0, heldHours: 1 }],
      sessionPnl: 0,
    });
    await loop.runOnce();
    expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');

    // Second cycle immediately after: LLM wants LONG again — should be skipped
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 10, positions: [], sessionPnl: 0,
    });
    mockLlm.analyze.mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 're-enter' },
    ]);
    mockOrders.execute.mockClear();
    await loop.runOnce();

    expect(mockOrders.execute).not.toHaveBeenCalled(); // blocked by cooldown
  });
```

**Step 3: Run to verify failure**
```bash
npx vitest run tests/trading-loop.test.ts
```
Expected: FAIL — new test fails, cooldown not implemented yet

**Step 4: Implement cooldown in `src/trading-loop.ts`**

Add to `TradingLoopDeps` interface (after `newsConfig`):
```typescript
  // already in newsConfig
```

Add private field to `TradingLoop` class (after `cycleCount`):
```typescript
  private lastClosedAt = new Map<string, number>();
```

Add to `TradingLoopDeps` interface:
```typescript
  churnCooldownMs: number;
```

In the decisions loop, before the LONG/SHORT execution block, add cooldown check:

Find the block:
```typescript
        } else {
          const result = await orders.execute(decision, portfolio.balanceUsd);
```

Replace with:
```typescript
        } else {
          // Anti-churn: skip if pair was closed within cooldown window
          const lastClose = this.lastClosedAt.get(decision.pair);
          if (lastClose && Date.now() - lastClose < this.deps.churnCooldownMs) {
            console.log(`[Churn] Skipping ${decision.pair} ${decision.action} — cooldown active (${Math.round((this.deps.churnCooldownMs - (Date.now() - lastClose)) / 60000)}m remaining)`);
            continue;
          }
          const result = await orders.execute(decision, portfolio.balanceUsd);
```

After the successful CLOSE execution, record the close time:
```typescript
            if (result.success) {
              logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
              this.lastClosedAt.set(decision.pair, Date.now()); // record for cooldown
            }
```

Add `churnCooldownMs` to `TradingLoopDeps` and update `tests/trading-loop.test.ts` mock + `src/index.ts`.

In `src/index.ts`, add to TradingLoop constructor:
```typescript
    churnCooldownMs: config.trading.churnCooldownMs,
```

In `tests/trading-loop.test.ts`, add to constructor:
```typescript
      churnCooldownMs: 900000,
```

**Step 5: Run tests**
```bash
npx vitest run tests/trading-loop.test.ts
```
Expected: all 6 tests pass

**Step 6: TypeScript check + full suite**
```bash
npx vitest run tests/ && npx tsc --noEmit
```

**Step 7: Commit**
```bash
git add src/config.ts src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat: add anti-churn cooldown per pair after close"
```

---

### Task 3: Dynamic MAX_LOSS_PCT in `src/risk/manager.ts` + config

**Files:**
- Modify: `src/config.ts`
- Modify: `src/risk/manager.ts`
- Modify: `tests/risk/manager.test.ts` (read first)

**What's broken:** `MAX_LOSS_USD=$5` on a $5,000 testnet account = 0.1% — bot shuts down after the first tiny loss. On real $50 account, $5 = 10% which is fine. But the config is a fixed number, not relative. Fix: add `MAX_LOSS_PCT` (default 10%) and compute `maxLossUsd = balance * maxLossPct / 100` dynamically.

**Step 1: Read `tests/risk/manager.test.ts`**
Read the file to understand existing test structure.

**Step 2: Update `src/risk/manager.ts`**

Add `maxLossPct` to `RiskConfig`:
```typescript
interface RiskConfig {
  maxLeverage: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxStopLossPct: number;
  maxLossUsd: number;    // kept for backward compat — used only if maxLossPct is 0
  maxLossPct: number;    // % of balance, takes priority if > 0
}
```

Update the loss check in `validate()`:
```typescript
    const effectiveMaxLoss = this.config.maxLossPct > 0
      ? portfolio.balanceUsd * this.config.maxLossPct / 100
      : this.config.maxLossUsd;

    if (portfolio.sessionPnl <= -effectiveMaxLoss) {
      return { approved: false, reason: `Session loss exceeded max ($${effectiveMaxLoss.toFixed(2)}) — shutdown triggered`, shutdown: true };
    }
```

**Step 3: Update `src/config.ts`**

Add to `Config` interface `trading` section:
```typescript
    maxLossPct: number;
```

Add to `loadConfig()`:
```typescript
      maxLossPct: parseFloat(process.env.MAX_LOSS_PCT || '10'),
```

**Step 4: Update `src/index.ts`**

Add `maxLossPct` to `RiskManager` constructor:
```typescript
  const riskManager = new RiskManager({
    maxLeverage: config.trading.maxLeverage,
    maxPositionPct: config.trading.maxPositionPct,
    maxExposurePct: config.trading.maxExposurePct,
    maxStopLossPct: config.trading.maxStopLossPct,
    maxLossUsd: config.trading.maxLossUsd,
    maxLossPct: config.trading.maxLossPct,
  });
```

**Step 5: Write test for dynamic threshold**

In `tests/risk/manager.test.ts`, add:
```typescript
  it('uses maxLossPct % of balance when set', () => {
    const rm = new RiskManager({
      maxLeverage: 20, maxPositionPct: 50, maxExposurePct: 150,
      maxStopLossPct: 5, maxLossUsd: 5, maxLossPct: 10,
    });
    const portfolio = { balanceUsd: 50, positions: [], sessionPnl: -4.9 };
    // $4.9 loss on $50 balance = 9.8% — below 10% threshold
    expect(rm.validate({ pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 2, stop_loss_pct: 2, take_profit_pct: 5, reasoning: '' }, portfolio).approved).toBe(true);

    const portfolio2 = { balanceUsd: 50, positions: [], sessionPnl: -5.1 };
    // $5.1 loss on $50 = 10.2% — exceeds 10%
    expect(rm.validate({ pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 2, stop_loss_pct: 2, take_profit_pct: 5, reasoning: '' }, portfolio2).shutdown).toBe(true);
  });
```

**Step 6: Run tests**
```bash
npx vitest run tests/risk/
```
Expected: all pass including new test

**Step 7: TypeScript check + full suite**
```bash
npx vitest run tests/ && npx tsc --noEmit
```

**Step 8: Commit**
```bash
git add src/config.ts src/risk/manager.ts src/index.ts tests/risk/manager.test.ts
git commit -m "feat: dynamic MAX_LOSS_PCT as % of balance instead of fixed USD"
```

---

### Task 4: Final verification

**Step 1: Full test suite**
```bash
npx vitest run tests/
```
Expected: all pass, 0 failures

**Step 2: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: 0 errors

**Step 3: Restart bot**
```bash
pm2 restart indic-bot && sleep 10 && pm2 logs indic-bot --lines 20 --nostream
```
Look for: NO "Order type not supported" errors on new positions

**Step 4: Verify on Binance testnet**
Open a position and confirm 3 orders appear: MARKET (filled) + STOP_MARKET (working) + TAKE_PROFIT_MARKET (working)
