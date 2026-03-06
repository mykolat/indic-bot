# Issue #10: Price Rounding Hardcoded to 2dp — 11 ORDER_FAIL Errors

**Priority:** CRITICAL — 11 lost trades due to Binance rejecting orders with invalid price precision.

## Problem

`roundPrice()` in `src/binance/orders.ts:198-200` always rounds to 2 decimal places:

```typescript
private roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}
```

This works for BTC ($70,000.12) and ETH ($3,500.45), but fails for low-price assets where Binance requires more precision:

| Pair      | tickSize   | Required dp | Current dp | Result          |
|-----------|------------|-------------|------------|-----------------|
| DOGEUSDT  | 0.00001    | 5           | 2          | ORDER_FAIL      |
| ADAUSDT   | 0.00010    | 4           | 2          | ORDER_FAIL      |
| XRPUSDT   | 0.0001     | 4           | 2          | ORDER_FAIL      |
| BTCUSDT   | 0.10       | 1           | 2          | OK (overprecise)|
| ETHUSDT   | 0.01       | 2           | 2          | OK              |

Binance rejects SL/TP orders with error `-1111 Precision is over the maximum defined for this asset`. When SL placement fails, the bot immediately closes the position (safety mechanism at `orders.ts:72-90`), so every affected trade is entered then immediately closed at a loss.

`roundQuantity()` (`orders.ts:192-196`) partially works — it reads from a `stepDecimals` map populated at startup from `exchangeInfo` (`src/index.ts:80-97`). But `roundPrice()` ignores this data entirely.

## Solution

1. Extract `tickSize` alongside `stepSize` from `exchangeInfo` at startup
2. Pass both maps (`stepDecimals` + `priceDecimals`) to `OrderExecutor`
3. Make `roundPrice()` use per-pair precision from `priceDecimals`, with a safe fallback
4. Extract the precision-calculation helper into a pure, testable function

## Files Changed

| File | Change |
|------|--------|
| `src/binance/orders.ts` | Add `priceDecimals` map, update `roundPrice()` signature, add `computeDecimalsFromStep()` |
| `src/index.ts` | Extract `PRICE_FILTER` tickSize, pass `priceDecimals` to `OrderExecutor` |
| `tests/binance/orders.test.ts` | New tests for price rounding per pair |

## Implementation Tasks

### Task 1: Add `computeDecimalsFromStep()` pure helper + tests (3 min)

Extract the step-to-decimals logic already in `src/index.ts:89` into a reusable pure function that both `stepSize` and `tickSize` parsing can share.

**1a. Write failing test**

Add to `tests/binance/orders.test.ts`:

```typescript
import { computeDecimalsFromStep } from '../../src/binance/orders.js';

describe('computeDecimalsFromStep', () => {
  it('returns 0 for stepSize >= 1', () => {
    expect(computeDecimalsFromStep('1')).toBe(0);
    expect(computeDecimalsFromStep('10')).toBe(0);
  });

  it('returns correct decimals for fractional stepSize', () => {
    expect(computeDecimalsFromStep('0.1')).toBe(1);      // BTCUSDT tickSize
    expect(computeDecimalsFromStep('0.01')).toBe(2);     // ETHUSDT tickSize
    expect(computeDecimalsFromStep('0.0001')).toBe(4);   // XRPUSDT tickSize
    expect(computeDecimalsFromStep('0.00001')).toBe(5);  // DOGEUSDT tickSize
    expect(computeDecimalsFromStep('0.001')).toBe(3);    // SOLUSDT stepSize
  });

  it('handles edge case of stepSize with trailing zeros', () => {
    expect(computeDecimalsFromStep('0.00010')).toBe(4);  // trailing zero
    expect(computeDecimalsFromStep('0.10000')).toBe(1);
  });
});
```

**1b. Verify test fails** — `npx vitest run tests/binance/orders.test.ts`

Expected: `computeDecimalsFromStep is not a function` (not exported yet).

**1c. Implement**

Add to `src/binance/orders.ts` (before the `OrderExecutor` class, as a named export):

```typescript
/** Convert a Binance step/tick size string (e.g. "0.0001") to decimal count (4). */
export function computeDecimalsFromStep(stepStr: string): number {
  const step = parseFloat(stepStr);
  if (step >= 1) return 0;
  // Count decimal places from the string to avoid float precision issues
  const parts = stepStr.replace(/0+$/, '').split('.');
  return parts.length > 1 ? parts[1].length : 0;
}
```

**1d. Verify test passes** — `npx vitest run tests/binance/orders.test.ts`

**1e. Commit** — `git commit -m "feat(orders): add computeDecimalsFromStep pure helper"`

---

### Task 2: Add `priceDecimals` to `OrderExecutor` + update `roundPrice()` (4 min)

**2a. Write failing test**

Add to `tests/binance/orders.test.ts`:

```typescript
describe('roundPrice per-pair precision', () => {
  it('rounds DOGEUSDT SL/TP to 5dp (tickSize 0.00001)', async () => {
    const priceDecimals = new Map([['DOGEUSDT', 5]]);
    const stepDecimals = new Map([['DOGEUSDT', 0]]);
    const exec = new OrderExecutor(mockClient, stepDecimals, priceDecimals);

    mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '0.17432' });
    mockClient.submitNewOrder.mockResolvedValue({
      orderId: 1, fills: [{ price: '0.17432', qty: '100' }],
    });
    mockClient.submitNewAlgoOrder.mockResolvedValue({});

    const decision: TradeDecision = {
      pair: 'DOGEUSDT', action: 'LONG', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
    };

    await exec.execute(decision, 100);

    // SL call
    const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
    // 0.17432 * 0.98 = 0.1708336 → should round to 5dp: 0.17083
    expect(slPrice).toBe('0.17083');

    // TP call
    const tpPrice = mockClient.submitNewAlgoOrder.mock.calls[1][0].triggerPrice;
    // 0.17432 * 1.05 = 0.183036 → should round to 5dp: 0.18303
    expect(tpPrice).toBe('0.18303');
  });

  it('rounds ADAUSDT SL/TP to 4dp (tickSize 0.0001)', async () => {
    const priceDecimals = new Map([['ADAUSDT', 4]]);
    const stepDecimals = new Map([['ADAUSDT', 0]]);
    const exec = new OrderExecutor(mockClient, stepDecimals, priceDecimals);

    mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '0.7523' });
    mockClient.submitNewOrder.mockResolvedValue({
      orderId: 1, fills: [{ price: '0.7523', qty: '50' }],
    });
    mockClient.submitNewAlgoOrder.mockResolvedValue({});

    const decision: TradeDecision = {
      pair: 'ADAUSDT', action: 'SHORT', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
    };

    await exec.execute(decision, 100);

    const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
    // SHORT SL: 0.7523 * 1.02 = 0.767346 → 4dp: 0.7673
    expect(slPrice).toBe('0.7674');

    const tpPrice = mockClient.submitNewAlgoOrder.mock.calls[1][0].triggerPrice;
    // SHORT TP: 0.7523 * 0.95 = 0.714685 → 4dp: 0.7147
    expect(tpPrice).toBe('0.7147');
  });

  it('falls back to 2dp when pair not in priceDecimals map', async () => {
    const priceDecimals = new Map<string, number>(); // empty
    const exec = new OrderExecutor(mockClient, new Map(), priceDecimals);

    mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '50000' });
    mockClient.submitNewOrder.mockResolvedValue({
      orderId: 1, fills: [{ price: '50000', qty: '0.001' }],
    });
    mockClient.submitNewAlgoOrder.mockResolvedValue({});

    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
    };

    await exec.execute(decision, 1000);

    const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
    // 50000 * 0.98 = 49000 → 2dp fallback: "49000"
    expect(slPrice).toBe('49000');
  });

  it('adjustSlTp uses per-pair price precision', async () => {
    const priceDecimals = new Map([['DOGEUSDT', 5]]);
    const exec = new OrderExecutor(mockClient, new Map(), priceDecimals);

    mockClient.cancelAllAlgoOpenOrders.mockResolvedValue({});
    mockClient.submitNewAlgoOrder.mockResolvedValue({});

    await exec.adjustSlTp({
      pair: 'DOGEUSDT',
      side: 'LONG',
      newSlPrice: 0.170836,
      newTpPrice: 0.183036,
    });

    const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
    expect(slPrice).toBe('0.17084');

    const tpPrice = mockClient.submitNewAlgoOrder.mock.calls[1][0].triggerPrice;
    expect(tpPrice).toBe('0.18304');
  });
});
```

**2b. Verify test fails** — `npx vitest run tests/binance/orders.test.ts`

Expected: `OrderExecutor` constructor does not accept 3rd argument; `roundPrice` still hardcoded to 2dp.

**2c. Implement**

Edit `src/binance/orders.ts`:

1. Update the constructor to accept `priceDecimals` (line 16):

```typescript
export class OrderExecutor {
  private stepDecimals: Map<string, number>;
  private priceDecimals: Map<string, number>;

  constructor(
    private client: any,
    stepDecimals?: Map<string, number>,
    priceDecimals?: Map<string, number>,
  ) {
    this.stepDecimals = stepDecimals ?? new Map();
    this.priceDecimals = priceDecimals ?? new Map();
  }
```

2. Update `roundPrice()` to accept `pair` and use per-pair precision (line 198):

```typescript
private roundPrice(price: number, pair: string): number {
  const decimals = this.priceDecimals.get(pair) ?? 2;
  const factor = 10 ** decimals;
  return Math.round(price * factor) / factor;
}
```

3. Update all `this.roundPrice(...)` call sites to pass `pair`:
   - Line 69: `this.roundPrice(stopPrice)` → `this.roundPrice(stopPrice, decision.pair)`
   - Line 98: `this.roundPrice(tpPrice)` → `this.roundPrice(tpPrice, decision.pair)`
   - Line 166: `this.roundPrice(newSlPrice)` → `this.roundPrice(newSlPrice, pair)`
   - Line 178: `this.roundPrice(newTpPrice)` → `this.roundPrice(newTpPrice, pair)`

4. Update the `String()` wrapper to use `toFixed()` for consistent formatting. Change the pattern from `String(this.roundPrice(...))` to a helper that formats correctly:

```typescript
private formatPrice(price: number, pair: string): string {
  const decimals = this.priceDecimals.get(pair) ?? 2;
  const factor = 10 ** decimals;
  const rounded = Math.round(price * factor) / factor;
  return decimals > 0 ? rounded.toFixed(decimals) : String(rounded);
}
```

Then replace all `String(this.roundPrice(...))` with `this.formatPrice(...)`:
   - Line 69: `triggerPrice: this.formatPrice(stopPrice, decision.pair),`
   - Line 98: `triggerPrice: this.formatPrice(tpPrice, decision.pair),`
   - Line 166: `triggerPrice: this.formatPrice(newSlPrice, pair),`
   - Line 178: `triggerPrice: this.formatPrice(newTpPrice, pair),`

**2d. Verify test passes** — `npx vitest run tests/binance/orders.test.ts`

**2e. Commit** — `git commit -m "feat(orders): per-pair price precision from tickSize map"`

---

### Task 3: Extract `tickSize` from `exchangeInfo` in `src/index.ts` (3 min)

**3a. Write failing test**

No unit test needed for wiring code in `src/index.ts`. Instead, add an integration-style test to `tests/binance/orders.test.ts` that verifies the `computeDecimalsFromStep` function works with real Binance tickSize values for all configured pairs:

```typescript
describe('computeDecimalsFromStep — all configured pairs', () => {
  // Real Binance exchangeInfo tickSize values as of 2026-03
  const PAIR_TICK_SIZES: Record<string, string> = {
    BTCUSDT: '0.10',
    ETHUSDT: '0.01',
    SOLUSDT: '0.010',
    BNBUSDT: '0.010',
    XRPUSDT: '0.0001',
    DOGEUSDT: '0.000010',
    ADAUSDT: '0.00010',
    AVAXUSDT: '0.010',
  };

  const EXPECTED: Record<string, number> = {
    BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 2, BNBUSDT: 2,
    XRPUSDT: 4, DOGEUSDT: 5, ADAUSDT: 4, AVAXUSDT: 2,
  };

  for (const [pair, tickSize] of Object.entries(PAIR_TICK_SIZES)) {
    it(`${pair} tickSize=${tickSize} → ${EXPECTED[pair]}dp`, () => {
      expect(computeDecimalsFromStep(tickSize)).toBe(EXPECTED[pair]);
    });
  }
});
```

**3b. Verify test passes** (should already pass from Task 1 implementation).

**3c. Implement**

Edit `src/index.ts` lines 80-99. Add `PRICE_FILTER` extraction alongside existing `LOT_SIZE`:

```typescript
// Load exchange info for quantity + price precision
let stepDecimals = new Map<string, number>();
let priceDecimals = new Map<string, number>();
try {
  const info = await binanceClient.getExchangeInfo();
  for (const sym of info.symbols) {
    if (config.trading.pairs.includes(sym.symbol)) {
      const lotFilter = sym.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      if (lotFilter?.stepSize) {
        stepDecimals.set(sym.symbol, computeDecimalsFromStep(lotFilter.stepSize));
      }
      const priceFilter = sym.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      if (priceFilter?.tickSize) {
        priceDecimals.set(sym.symbol, computeDecimalsFromStep(priceFilter.tickSize));
      }
    }
  }
  console.log(`[Binance] Loaded precision for ${stepDecimals.size} pairs (qty: stepSize, price: tickSize)`);
} catch (e: any) {
  console.warn(`[Binance] Failed to load exchangeInfo: ${e.message} — using defaults`);
}

const orders = new OrderExecutor(binanceClient, stepDecimals, priceDecimals);
```

Add the import at the top of `src/index.ts`:
```typescript
import { computeDecimalsFromStep } from './binance/orders.js';
```

This also replaces the inline `Math.round(-Math.log10(step))` with the tested `computeDecimalsFromStep()`.

**3d. Verify all tests pass** — `npx vitest run tests/binance/`

**3e. Commit** — `git commit -m "feat(index): extract tickSize from exchangeInfo for price precision"`

---

### Task 4: Verify existing tests still pass + run full suite (2 min)

**4a.** Run the full test suite:
```bash
npx vitest run
```

**4b.** Check that existing `OrderExecutor` tests pass unchanged. The constructor change is backward-compatible (3rd arg is optional with `?`).

**4c.** Verify the `adjustSlTp` tests at `tests/binance/orders.test.ts:204-245` still pass (they use the default `OrderExecutor(mockClient)` constructor which now defaults to empty maps for both).

**4d. Commit** — `git commit -m "test: verify all existing tests pass with price precision changes"`

---

## Verification Checklist

- [ ] `computeDecimalsFromStep('0.00001')` returns `5` (DOGE)
- [ ] `computeDecimalsFromStep('0.0001')` returns `4` (ADA, XRP)
- [ ] `computeDecimalsFromStep('0.01')` returns `2` (ETH)
- [ ] `computeDecimalsFromStep('0.1')` returns `1` (BTC)
- [ ] `OrderExecutor` constructor backward-compatible (2-arg callers still work)
- [ ] SL/TP `triggerPrice` strings have correct decimal places per pair
- [ ] `adjustSlTp` also uses per-pair precision
- [ ] `src/index.ts` extracts both `LOT_SIZE` and `PRICE_FILTER` from `exchangeInfo`
- [ ] All 39+ existing tests pass
- [ ] No runtime changes for pairs that already worked (BTC, ETH)

## Risk Assessment

- **Low risk**: Constructor change is additive (optional 3rd param). Existing callers get `Map()` default = same 2dp behavior.
- **Fallback**: If `exchangeInfo` fetch fails at startup, `priceDecimals` stays empty → falls back to 2dp (same as current behavior).
- **Edge case**: If Binance changes a pair's `tickSize` between bot restarts, the cached precision could be stale. This is acceptable since the bot restarts daily via pm2.
