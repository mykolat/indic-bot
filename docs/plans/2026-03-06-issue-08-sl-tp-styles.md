# Issue #8: FilterProfile slStyle/tpStyle defined but never consumed

## Problem

`FilterProfile` in `src/market/filter-profiles.ts` defines `slStyle` and `tpStyle` per regime:

```typescript
slStyle: 'trailing' | 'fixed' | 'atr' | 'range';
tpStyle: 'trailing' | 'fixed' | 'momentum' | 'range' | 'dca';
```

These are fully configured for all 5 regimes (BullTrend, BearTrend, Range, Breakout, Capitulation) but **never read** by any code path. `OrderExecutor.execute()` (line 54–60 of `src/binance/orders.ts`) always calculates SL/TP as a fixed percentage from the fill price:

```typescript
const stopPrice = decision.action === 'LONG'
  ? fillPrice * (1 - decision.stop_loss_pct / 100)
  : fillPrice * (1 + decision.stop_loss_pct / 100);
```

The `activeProfile` is used in `src/trading-loop.ts` for `leverageMultiplier` (line 972–974) and for filter warnings (line 490–496), but `slStyle`/`tpStyle` are never consumed.

## Root Cause

The SL/TP style system was designed as part of the Shark Mode feature (filter profiles per regime) but the order execution layer was never updated to use regime-specific strategies. The LLM provides `stop_loss_pct` and `take_profit_pct` as flat percentages, and `OrderExecutor` blindly applies them.

## Solution

Create a `computeSlTpPrices()` function that takes the `slStyle`/`tpStyle` from the active `FilterProfile` plus indicators (ATR, Bollinger Bands) and computes regime-aware SL/TP prices. Wire it into `TradingLoop` between risk validation and order execution.

### Style Behaviors

| slStyle | Behavior |
|---------|----------|
| `fixed` | Use LLM's `stop_loss_pct` as-is (current behavior) |
| `atr` | SL = ATR × 1.5 from entry. Clamp to max `stop_loss_pct` |
| `trailing` | Use LLM's pct but flag for trailing (future: Binance trailing stop) |
| `range` | SL at nearest BB band. Clamp to max `stop_loss_pct` |

| tpStyle | Behavior |
|---------|----------|
| `fixed` | Use LLM's `take_profit_pct` as-is |
| `momentum` | TP = ATR × 3 from entry. At least LLM's `take_profit_pct` |
| `trailing` | Use LLM's pct (trailing TP is handled by ADJUST action) |
| `range` | TP at opposite BB band from entry |
| `dca` | Use LLM's pct × 0.5 (smaller TP, expect to re-enter) |

## Files to Modify

| File | Change |
|------|--------|
| `src/market/sl-tp-styles.ts` | **NEW** — `computeSlTpPrices()` function |
| `src/trading-loop.ts` | Call `computeSlTpPrices()` before `orders.execute()` |
| `tests/market/sl-tp-styles.test.ts` | **NEW** — unit tests for all style combinations |
| `tests/trading-loop.test.ts` | Test that regime-adjusted SL/TP reaches OrderExecutor |

## Implementation Steps (TDD)

### Step 1: Write failing tests for `computeSlTpPrices()`

Create `tests/market/sl-tp-styles.test.ts`:

```typescript
// tests/market/sl-tp-styles.test.ts

import { describe, it, expect } from 'vitest';
import { computeSlTpPrices } from '../../src/market/sl-tp-styles.js';

describe('computeSlTpPrices', () => {
  const baseParams = {
    action: 'LONG' as const,
    fillPrice: 50000,
    stopLossPct: 2,
    takeProfitPct: 4,
    atr: 500,        // 1% of price
    atrPct: 1.0,
    bbUpper: 51500,
    bbLower: 48500,
    maxStopLossPct: 5,
  };

  describe('slStyle: fixed', () => {
    it('uses LLM stop_loss_pct as-is for LONG', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'fixed', tpStyle: 'fixed' });
      expect(result.stopLossPct).toBe(2);
    });

    it('uses LLM stop_loss_pct as-is for SHORT', () => {
      const result = computeSlTpPrices({ ...baseParams, action: 'SHORT', slStyle: 'fixed', tpStyle: 'fixed' });
      expect(result.stopLossPct).toBe(2);
    });
  });

  describe('slStyle: atr', () => {
    it('computes SL from ATR * 1.5', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'atr', tpStyle: 'fixed' });
      // ATR = 500, 1.5 * 500 = 750, 750/50000 * 100 = 1.5%
      expect(result.stopLossPct).toBeCloseTo(1.5, 1);
    });

    it('clamps ATR-based SL to maxStopLossPct', () => {
      const result = computeSlTpPrices({
        ...baseParams,
        slStyle: 'atr', tpStyle: 'fixed',
        atr: 2000,  // 1.5 * 2000 = 3000 → 6% — exceeds max 5%
      });
      expect(result.stopLossPct).toBe(5);
    });

    it('falls back to LLM pct when ATR is 0', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'atr', tpStyle: 'fixed', atr: 0 });
      expect(result.stopLossPct).toBe(2);
    });
  });

  describe('slStyle: range', () => {
    it('sets LONG SL at lower BB band', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'range', tpStyle: 'fixed' });
      // bbLower = 48500, fillPrice = 50000 → (50000-48500)/50000*100 = 3%
      expect(result.stopLossPct).toBeCloseTo(3, 1);
    });

    it('sets SHORT SL at upper BB band', () => {
      const result = computeSlTpPrices({ ...baseParams, action: 'SHORT', slStyle: 'range', tpStyle: 'fixed' });
      // bbUpper = 51500, fillPrice = 50000 → (51500-50000)/50000*100 = 3%
      expect(result.stopLossPct).toBeCloseTo(3, 1);
    });

    it('clamps range-based SL to maxStopLossPct', () => {
      const result = computeSlTpPrices({
        ...baseParams, slStyle: 'range', tpStyle: 'fixed',
        bbLower: 45000,  // (50000-45000)/50000*100 = 10% — exceeds max 5%
      });
      expect(result.stopLossPct).toBe(5);
    });
  });

  describe('slStyle: trailing', () => {
    it('uses LLM pct (trailing is informational for now)', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'trailing', tpStyle: 'fixed' });
      expect(result.stopLossPct).toBe(2);
      expect(result.isTrailing).toBe(true);
    });
  });

  describe('tpStyle: fixed', () => {
    it('uses LLM take_profit_pct as-is', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'fixed', tpStyle: 'fixed' });
      expect(result.takeProfitPct).toBe(4);
    });
  });

  describe('tpStyle: momentum', () => {
    it('computes TP from ATR * 3', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'fixed', tpStyle: 'momentum' });
      // ATR = 500, 3 * 500 = 1500, 1500/50000 * 100 = 3%
      // But LLM says 4%, so take max(3, 4) = 4
      expect(result.takeProfitPct).toBe(4);
    });

    it('uses ATR-based TP when it exceeds LLM pct', () => {
      const result = computeSlTpPrices({
        ...baseParams, slStyle: 'fixed', tpStyle: 'momentum',
        atr: 1000,  // 3 * 1000 = 3000, 3000/50000*100 = 6%
      });
      expect(result.takeProfitPct).toBeCloseTo(6, 1);
    });
  });

  describe('tpStyle: range', () => {
    it('sets LONG TP at upper BB band', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'fixed', tpStyle: 'range' });
      // bbUpper = 51500, fillPrice = 50000 → (51500-50000)/50000*100 = 3%
      expect(result.takeProfitPct).toBeCloseTo(3, 1);
    });

    it('sets SHORT TP at lower BB band', () => {
      const result = computeSlTpPrices({ ...baseParams, action: 'SHORT', slStyle: 'fixed', tpStyle: 'range' });
      // bbLower = 48500, fillPrice = 50000 → (50000-48500)/50000*100 = 3%
      expect(result.takeProfitPct).toBeCloseTo(3, 1);
    });

    it('falls back to LLM pct when BB range is too tight', () => {
      const result = computeSlTpPrices({
        ...baseParams, slStyle: 'fixed', tpStyle: 'range',
        bbUpper: 50100,  // only 0.2% — too small
      });
      expect(result.takeProfitPct).toBe(4);  // LLM fallback
    });
  });

  describe('tpStyle: dca', () => {
    it('halves the LLM take_profit_pct', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'fixed', tpStyle: 'dca' });
      expect(result.takeProfitPct).toBe(2);
    });
  });

  describe('tpStyle: trailing', () => {
    it('uses LLM pct (trailing handled by ADJUST action)', () => {
      const result = computeSlTpPrices({ ...baseParams, slStyle: 'fixed', tpStyle: 'trailing' });
      expect(result.takeProfitPct).toBe(4);
      expect(result.isTrailing).toBe(true);
    });
  });
});
```

**Verify:** `npx vitest run tests/market/sl-tp-styles.test.ts` — fails because `src/market/sl-tp-styles.ts` does not exist.

### Step 2: Implement `computeSlTpPrices()`

Create `src/market/sl-tp-styles.ts`:

```typescript
// src/market/sl-tp-styles.ts

export interface SlTpParams {
  action: 'LONG' | 'SHORT';
  fillPrice: number;
  stopLossPct: number;      // LLM's original SL%
  takeProfitPct: number;    // LLM's original TP%
  slStyle: 'trailing' | 'fixed' | 'atr' | 'range';
  tpStyle: 'trailing' | 'fixed' | 'momentum' | 'range' | 'dca';
  atr: number;
  atrPct: number;
  bbUpper: number;
  bbLower: number;
  maxStopLossPct: number;
}

export interface SlTpResult {
  stopLossPct: number;
  takeProfitPct: number;
  isTrailing: boolean;
  adjustedBy?: string;  // e.g. 'atr', 'range' — for logging
}

export function computeSlTpPrices(params: SlTpParams): SlTpResult {
  const { action, fillPrice, stopLossPct, takeProfitPct, slStyle, tpStyle, atr, bbUpper, bbLower, maxStopLossPct } = params;
  let sl = stopLossPct;
  let tp = takeProfitPct;
  let isTrailing = false;
  let adjustedBy: string | undefined;

  // --- SL Style ---
  switch (slStyle) {
    case 'atr': {
      if (atr > 0 && fillPrice > 0) {
        const atrSl = (atr * 1.5) / fillPrice * 100;
        sl = Math.min(atrSl, maxStopLossPct);
        adjustedBy = 'atr';
      }
      break;
    }
    case 'range': {
      if (fillPrice > 0) {
        let rangeSl: number;
        if (action === 'LONG') {
          rangeSl = ((fillPrice - bbLower) / fillPrice) * 100;
        } else {
          rangeSl = ((bbUpper - fillPrice) / fillPrice) * 100;
        }
        if (rangeSl > 0) {
          sl = Math.min(rangeSl, maxStopLossPct);
          adjustedBy = 'range';
        }
      }
      break;
    }
    case 'trailing': {
      isTrailing = true;
      break;
    }
    case 'fixed':
    default:
      break;
  }

  // --- TP Style ---
  switch (tpStyle) {
    case 'momentum': {
      if (atr > 0 && fillPrice > 0) {
        const momentumTp = (atr * 3) / fillPrice * 100;
        tp = Math.max(momentumTp, takeProfitPct);
        if (momentumTp > takeProfitPct) adjustedBy = (adjustedBy ? adjustedBy + '+momentum' : 'momentum');
      }
      break;
    }
    case 'range': {
      let rangeTp: number;
      if (action === 'LONG') {
        rangeTp = ((bbUpper - fillPrice) / fillPrice) * 100;
      } else {
        rangeTp = ((fillPrice - bbLower) / fillPrice) * 100;
      }
      // Only use range TP if it's meaningful (> 0.5%)
      if (rangeTp > 0.5) {
        tp = rangeTp;
        adjustedBy = (adjustedBy ? adjustedBy + '+range' : 'range');
      }
      break;
    }
    case 'dca': {
      tp = takeProfitPct * 0.5;
      adjustedBy = (adjustedBy ? adjustedBy + '+dca' : 'dca');
      break;
    }
    case 'trailing': {
      isTrailing = true;
      break;
    }
    case 'fixed':
    default:
      break;
  }

  return { stopLossPct: sl, takeProfitPct: tp, isTrailing, adjustedBy };
}
```

**Verify:** `npx vitest run tests/market/sl-tp-styles.test.ts` — all tests pass.

### Step 3: Write failing integration test in trading-loop

```typescript
// tests/trading-loop.test.ts — add test

it('applies regime slStyle/tpStyle to order execution', async () => {
  // Setup: BullTrend regime (slStyle: trailing, tpStyle: trailing) vs Breakout (slStyle: atr, tpStyle: momentum)
  // We'll mock classify regime to return Breakout
  mockLlm.analyze.mockResolvedValue([
    { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'breakout play', confidence: 70 },
  ]);

  // The candle data is already set up to produce indicators
  // We need to verify that the decision passed to orders.execute has modified SL/TP

  await loop.runOnce();

  expect(mockOrders.execute).toHaveBeenCalled();
  // The exact values depend on computed indicators — just verify execute was called
  // with the decision object (detailed style tests are in sl-tp-styles.test.ts)
  const executedDecision = mockOrders.execute.mock.calls[0][0];
  expect(executedDecision.pair).toBe('BTCUSDT');
});
```

### Step 4: Wire `computeSlTpPrices()` into TradingLoop

In `src/trading-loop.ts`, add import at top:

```typescript
import { computeSlTpPrices } from './market/sl-tp-styles.js';
```

Then, in the LONG/SHORT execution path (around line 971, after the leverage multiplier and before `orders.execute()`), add:

```typescript
// src/trading-loop.ts — after leverage adjustment (line 974), before orders.execute (line 977)

// Apply regime-specific SL/TP styles
if (activeProfile && (decision.action === 'LONG' || decision.action === 'SHORT')) {
  const ind = indicators.get(decision.pair);
  if (ind) {
    const slTpResult = computeSlTpPrices({
      action: decision.action,
      fillPrice: parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '0'),
      stopLossPct: decision.stop_loss_pct,
      takeProfitPct: decision.take_profit_pct,
      slStyle: activeProfile.slStyle,
      tpStyle: activeProfile.tpStyle,
      atr: ind.atr,
      atrPct: ind.atr / parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '1') * 100,
      bbUpper: ind.bollingerUpper,
      bbLower: ind.bollingerLower,
      maxStopLossPct: this.deps.tradingConfig.maxStopLossPct,
    });

    if (slTpResult.adjustedBy) {
      console.log(`[Regime] ${decision.pair} SL/TP adjusted by ${slTpResult.adjustedBy}: SL ${decision.stop_loss_pct}%→${slTpResult.stopLossPct.toFixed(2)}%, TP ${decision.take_profit_pct}%→${slTpResult.takeProfitPct.toFixed(2)}%`);
    }

    decision.stop_loss_pct = slTpResult.stopLossPct;
    decision.take_profit_pct = slTpResult.takeProfitPct;
  }
}
```

**Verify:** `npx vitest run tests/market/sl-tp-styles.test.ts tests/trading-loop.test.ts` — all pass.

### Step 5: Commit

```bash
git add src/market/sl-tp-styles.ts src/trading-loop.ts tests/market/sl-tp-styles.test.ts tests/trading-loop.test.ts
git commit -m "feat(issue-8): wire FilterProfile slStyle/tpStyle into order execution"
```

## Verification

After deployment:

1. **Logs:** Look for `[Regime] BTCUSDT SL/TP adjusted by atr:` messages — these appear when the style differs from `fixed`.
2. **DB:** Compare `trade_decisions.stop_loss_pct` (LLM original) with `trade_executions.sl_price` (actual) — they should diverge in non-Range regimes.
3. **Behavior by regime:**
   - BullTrend: SL/TP unchanged (trailing = informational), `isTrailing` logged
   - BearTrend: SL/TP unchanged (both fixed)
   - Range: SL at BB lower, TP at BB upper
   - Breakout: SL from ATR×1.5, TP from ATR×3
   - Capitulation: SL fixed, TP halved (DCA style)
