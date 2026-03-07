# Limit Order Entry Implementation Plan (#31)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace MARKET entry with LIMIT order + market fallback to reduce slippage at scale.

**Architecture:** Add `attemptLimitEntry()` method to `OrderExecutor`. Controlled by `useLimitEntry` config flag (default false). When enabled: place LIMIT at best bid/ask -> wait 3s -> check fill -> if unfilled, cancel and fall back to MARKET. SL/TP flow unchanged.

**Tech Stack:** TypeScript ESM, `binance` npm (USDMClient), Vitest

---

### Task 1: Config flag + types

**Files:**
- Modify: `config.yaml` (add `useLimitEntry: false`)
- Modify: `src/config.ts` (add field to trading config)

**Step 1: Add config**

In `config.yaml` under `trading:`:
```yaml
  useLimitEntry: false        # Enable at balance > $5K
  limitEntryTimeoutMs: 3000   # Wait time before market fallback
```

In `src/config.ts`, in the trading config section:
```typescript
useLimitEntry: t.useLimitEntry ?? false,
limitEntryTimeoutMs: t.limitEntryTimeoutMs ?? 3000,
```

**Step 2: Commit**
```bash
git add config.yaml src/config.ts
git commit -m "feat(config): add useLimitEntry flag and timeout (#31)"
```

---

### Task 2: Implement limit entry with fallback

**Files:**
- Modify: `src/binance/orders.ts` (add `attemptLimitEntry()`, modify `execute()`)
- Test: `tests/binance/orders.test.ts`

**Step 1: Write failing tests**

Add to `tests/binance/orders.test.ts`:

```typescript
describe('limit order entry', () => {
  it('uses LIMIT order when useLimitEntry is true and order fills', async () => {
    const limitClient = {
      ...mockClient,
      submitNewOrder: vi.fn()
        .mockResolvedValueOnce({
          orderId: 100, status: 'FILLED',
          fills: [{ price: '50000.00', qty: '0.001', commission: '0.005', commissionAsset: 'USDT' }],
        }),
      getOrder: vi.fn().mockResolvedValue({ status: 'FILLED' }),
      getOrderBook: vi.fn().mockResolvedValue({
        bids: [['49999.00', '1.0']], asks: [['50001.00', '1.0']],
      }),
    };
    const exec = new OrderExecutor(limitClient as any, undefined, undefined, { useLimitEntry: true, limitEntryTimeoutMs: 0 });
    const result = await exec.execute(
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test' },
      10000,
    );
    expect(result.success).toBe(true);
    expect(limitClient.submitNewOrder.mock.calls[0][0].type).toBe('LIMIT');
    expect(limitClient.submitNewOrder.mock.calls[0][0].price).toBeDefined();
  });

  it('falls back to MARKET when LIMIT not filled within timeout', async () => {
    const limitClient = {
      ...mockClient,
      submitNewOrder: vi.fn()
        .mockResolvedValueOnce({ orderId: 100, status: 'NEW' })
        .mockResolvedValueOnce({
          orderId: 101, status: 'FILLED',
          fills: [{ price: '50000.00', qty: '0.001', commission: '0.01', commissionAsset: 'USDT' }],
        }),
      getOrder: vi.fn().mockResolvedValue({ status: 'NEW' }),
      cancelOrder: vi.fn().mockResolvedValue({}),
      getOrderBook: vi.fn().mockResolvedValue({
        bids: [['49999.00', '1.0']], asks: [['50001.00', '1.0']],
      }),
    };
    const exec = new OrderExecutor(limitClient as any, undefined, undefined, { useLimitEntry: true, limitEntryTimeoutMs: 0 });
    const result = await exec.execute(
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test' },
      10000,
    );
    expect(result.success).toBe(true);
    expect(limitClient.cancelOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: 100 });
    expect(limitClient.submitNewOrder.mock.calls[1][0].type).toBe('MARKET');
  });

  it('does not use LIMIT when useLimitEntry is false', async () => {
    const exec = new OrderExecutor(mockClient as any);
    const result = await exec.execute(
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test' },
      10000,
    );
    expect(result.success).toBe(true);
    expect(mockClient.submitNewOrder.mock.calls[0][0].type).toBe('MARKET');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: FAIL -- OrderExecutor constructor doesn't accept entry options

**Step 3: Implement**

In `src/binance/orders.ts`:

1. Add options interface and modify constructor:
```typescript
export interface EntryOptions {
  useLimitEntry?: boolean;
  limitEntryTimeoutMs?: number;
}

export class OrderExecutor {
  constructor(
    private client: any,
    private stepDecimals?: Map<string, number>,
    private priceDecimals?: Map<string, number>,
    private entryOptions?: EntryOptions,
  ) {}
```

2. Add `attemptLimitEntry()` method:
```typescript
  private async attemptLimitEntry(
    pair: string, side: string, quantity: number,
  ): Promise<{ filled: boolean; order?: any }> {
    const book = await this.client.getOrderBook({ symbol: pair, limit: 5 });
    const limitPrice = side === 'BUY'
      ? parseFloat(book.bids[0][0])
      : parseFloat(book.asks[0][0]);

    const order = await this.client.submitNewOrder({
      symbol: pair,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(quantity),
      price: this.formatPrice(limitPrice, pair),
    });

    if (order.status === 'FILLED') {
      return { filled: true, order };
    }

    const timeout = this.entryOptions?.limitEntryTimeoutMs ?? 3000;
    if (timeout > 0) await new Promise(r => setTimeout(r, timeout));

    const status = await this.client.getOrder({ symbol: pair, orderId: order.orderId });
    if (status.status === 'FILLED') {
      return { filled: true, order: status };
    }

    await this.client.cancelOrder({ symbol: pair, orderId: order.orderId }).catch(() => {});
    console.log(`[Orders] LIMIT not filled for ${pair}, falling back to MARKET`);
    return { filled: false };
  }
```

3. Modify `execute()` -- before the existing MARKET order block, add:
```typescript
    if (this.entryOptions?.useLimitEntry) {
      try {
        const attempt = await this.attemptLimitEntry(decision.pair, side, quantity);
        if (attempt.filled && attempt.order) {
          // Use limit fill data -- extract fillPrice from order
          // ... same fill extraction logic as MARKET
          // Then continue to SL/TP placement
        }
        // If not filled, fall through to MARKET below
      } catch (err: any) {
        console.error(`[Orders] LIMIT attempt failed: ${err.message}, using MARKET`);
      }
    }
```

4. Pass `entryOptions` from `TradingLoop` when constructing `OrderExecutor` (in `src/index.ts`).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: ALL PASS

**Step 5: Commit**
```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "feat(orders): limit order entry with market fallback (#31)"
```

---

### Task 3: Wire into index.ts

**Files:**
- Modify: `src/index.ts` (pass entryOptions to OrderExecutor)

**Step 1: Pass config to OrderExecutor**

Find OrderExecutor construction in `src/index.ts` and add entryOptions:
```typescript
const orders = new OrderExecutor(
  binanceClient, stepDecimals, priceDecimals,
  { useLimitEntry: config.trading.useLimitEntry, limitEntryTimeoutMs: config.trading.limitEntryTimeoutMs },
);
```

**Step 2: Commit**
```bash
git add src/index.ts
git commit -m "feat(orders): wire limit entry config into OrderExecutor (#31)"
```

---

## Verification

1. `npx vitest run tests/binance/orders.test.ts` -- all pass
2. `npx vitest run` -- full suite passes (386+ tests)
3. Config flag `useLimitEntry: false` -- default behavior unchanged
4. Set `useLimitEntry: true` in config.yaml for future use at higher balances
