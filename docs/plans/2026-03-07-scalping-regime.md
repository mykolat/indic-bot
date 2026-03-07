# Scalping Regime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `Scalping` market regime that activates during low-volume dead-zone periods (Asia/night sessions) with tight SL/TP, minimal leverage, and clear trade labeling so scalp trades are never confused with swing trades during review.

**Architecture:** New `Scalping` enum value in `MarketRegime` → classifier detects it when volume < 0.5x AND ADX < 25 AND not Capitulation → FilterProfile sets tight params (leverageMultiplier 0.1, high minConfidence 72) → config.yaml adds `scalpingMinTakeProfitPct` and `scalpingMaxStopLossPct` → DB column `strategy_type` on `trade_executions` marks every scalp trade.

**Tech Stack:** TypeScript ESM, Vitest, Supabase PostgreSQL (MCP migration), pg npm

---

### Task 1: Add `Scalping` to MarketRegime enum + classifier

**Files:**
- Modify: `src/market/regime-classifier.ts`
- Test: `tests/market/regime-classifier.test.ts`

**Step 1: Write failing test**

Create `tests/market/regime-classifier.test.ts` (or add to existing if it exists):

```typescript
import { describe, it, expect } from 'vitest';
import { classifyRegime, MarketRegime } from '../../src/market/regime-classifier.js';

const baseIndicators = () => ({
  rsi: 50, ema20: 100, ema50: 100, atr: 1,
  volumeRatio: 0.3, adx: 15, vwap: 100,
  bollingerPercentB: 50, bollingerBandwidth: 3,
  trend: 'sideways' as const,
  macd: 0, macdSignal: 0, macdHistogram: 0,
});

describe('classifyRegime — Scalping', () => {
  it('detects Scalping when volume < 0.5 AND ADX < 25 AND F&G > 15', () => {
    const result = classifyRegime(
      { ...baseIndicators(), volumeRatio: 0.3, adx: 14 },
      100,
      { value: 40 }, // neutral F&G, not capitulation
    );
    expect(result.regime).toBe(MarketRegime.Scalping);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('does NOT detect Scalping when F&G < 15 (Capitulation takes priority)', () => {
    const result = classifyRegime(
      { ...baseIndicators(), volumeRatio: 0.3, adx: 14 },
      100,
      { value: 10 }, // extreme fear → Capitulation
    );
    expect(result.regime).toBe(MarketRegime.Capitulation);
  });

  it('does NOT detect Scalping when volume >= 0.5', () => {
    const result = classifyRegime(
      { ...baseIndicators(), volumeRatio: 0.7, adx: 14 },
      100,
      { value: 40 },
    );
    expect(result.regime).not.toBe(MarketRegime.Scalping);
  });

  it('does NOT detect Scalping when ADX >= 25 (trend too strong)', () => {
    const result = classifyRegime(
      { ...baseIndicators(), volumeRatio: 0.3, adx: 27, ema20: 105, ema50: 100 },
      105,
      { value: 40 },
    );
    expect(result.regime).not.toBe(MarketRegime.Scalping);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/market/regime-classifier.test.ts
```
Expected: FAIL — `MarketRegime.Scalping` does not exist

**Step 3: Add `Scalping` to enum and classifier**

In `src/market/regime-classifier.ts`, add to enum:
```typescript
export enum MarketRegime {
  BullTrend = 'BullTrend',
  BearTrend = 'BearTrend',
  Range = 'Range',
  Breakout = 'Breakout',
  Capitulation = 'Capitulation',
  Scalping = 'Scalping',
}
```

Add before the `// --- Priority 5: Range ---` block (after BearTrend, before Range):

```typescript
  // --- Priority 4.5: Scalping (low volume dead zone) ---
  const isDeadZone = indicators.volumeRatio < 0.5 && indicators.adx < 25;
  if (isDeadZone) {
    factors.push(`dead zone: volume ${indicators.volumeRatio.toFixed(2)}x, ADX ${indicators.adx.toFixed(0)}`);
    const confidence = Math.round(50 + (0.5 - indicators.volumeRatio) * 40);
    return { regime: MarketRegime.Scalping, confidence: Math.min(confidence, 75), factors };
  }
```

**Step 4: Run tests**

```bash
npx vitest run tests/market/regime-classifier.test.ts
```
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/market/regime-classifier.ts tests/market/regime-classifier.test.ts
git commit -m "feat(regime): add Scalping regime for low-volume dead-zone markets"
```

---

### Task 2: Add Scalping FilterProfile

**Files:**
- Modify: `src/market/filter-profiles.ts`
- Test: `tests/market/filter-profiles.test.ts`

**Step 1: Write failing test**

Create `tests/market/filter-profiles.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getFilterProfile } from '../../src/market/filter-profiles.js';
import { MarketRegime } from '../../src/market/regime-classifier.js';

describe('FilterProfile — Scalping', () => {
  it('has very low leverage multiplier (0.1)', () => {
    const p = getFilterProfile(MarketRegime.Scalping);
    expect(p.leverageMultiplier).toBe(0.1);
  });

  it('requires high confidence (72+) to compensate for low liquidity', () => {
    const p = getFilterProfile(MarketRegime.Scalping);
    expect(p.minConfidence).toBeGreaterThanOrEqual(72);
  });

  it('allows very low volume (0.15)', () => {
    const p = getFilterProfile(MarketRegime.Scalping);
    expect(p.volumeMin).toBeLessThanOrEqual(0.15);
  });

  it('uses fixed SL and TP styles', () => {
    const p = getFilterProfile(MarketRegime.Scalping);
    expect(p.slStyle).toBe('fixed');
    expect(p.tpStyle).toBe('fixed');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/market/filter-profiles.test.ts
```
Expected: FAIL — `Scalping` not in PROFILES

**Step 3: Add profile**

In `src/market/filter-profiles.ts`, add to PROFILES:

```typescript
    [MarketRegime.Scalping]: {
        rsiRange: [30, 70],
        volumeMin: 0.15,
        confluenceMin: 1,
        leverageMultiplier: 0.1,   // maxLeverage 20 → 2x max
        minConfidence: 72,          // high bar — low liquidity = more false signals
        slStyle: 'fixed',
        tpStyle: 'fixed',
    },
```

**Step 4: Run tests**

```bash
npx vitest run tests/market/filter-profiles.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/market/filter-profiles.ts tests/market/filter-profiles.test.ts
git commit -m "feat(regime): add Scalping FilterProfile — low leverage, tight params, high confidence"
```

---

### Task 3: Add scalping TP/SL config params

**Files:**
- Modify: `config.yaml`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (if exists, else skip — config is covered by integration)

**Step 1: Add to `config.yaml`**

Under `trading:`:
```yaml
  scalpingMinTakeProfitPct: 1.0    # tight TP for scalp trades (vs 5% for swing)
  scalpingMaxStopLossPct: 0.8      # tight SL for scalp trades
```

**Step 2: Add to `src/config.ts`**

Find the `TradingConfig` interface and add:
```typescript
  scalpingMinTakeProfitPct: number;
  scalpingMaxStopLossPct: number;
```

In `loadConfig()`, add defaults alongside existing trading params:
```typescript
scalpingMinTakeProfitPct: trading.scalpingMinTakeProfitPct ?? 1.0,
scalpingMaxStopLossPct: trading.scalpingMaxStopLossPct ?? 0.8,
```

**Step 3: Run full test suite**

```bash
npx vitest run
```
Expected: all tests pass

**Step 4: Commit**

```bash
git add config.yaml src/config.ts
git commit -m "feat(config): add scalpingMinTakeProfitPct and scalpingMaxStopLossPct"
```

---

### Task 4: Enforce scalping TP/SL limits in TradingLoop

**Files:**
- Modify: `src/trading-loop.ts` (around line 865 — decision validation block)
- Test: `tests/trading-loop.test.ts` (add scalping test cases)

**Context:** After `RiskManager.validate()` approves a decision, and after `computeSlTpPrices()` adjusts SL/TP, we need to cap `take_profit_pct` and `stop_loss_pct` to scalping limits when regime is Scalping.

**Step 1: Find the right location**

In `src/trading-loop.ts` around line 1080–1095 where `computeSlTpPrices` is called. After the adjusted values are set, add:

```typescript
// Cap TP/SL to scalping limits if in Scalping regime
if (marketRegime === MarketRegime.Scalping) {
  decision.take_profit_pct = Math.min(
    decision.take_profit_pct,
    config.scalpingMinTakeProfitPct,
  );
  decision.stop_loss_pct = Math.min(
    decision.stop_loss_pct,
    config.scalpingMaxStopLossPct,
  );
}
```

Also update the `minTakeProfitPct` check (around line 865) to use scalping limit when applicable:

```typescript
const minTP = marketRegime === MarketRegime.Scalping
  ? config.scalpingMinTakeProfitPct
  : config.minTakeProfitPct;
if (decision.take_profit_pct < minTP) { ... }
```

**Step 2: Run tests**

```bash
npx vitest run
```
Expected: all pass

**Step 3: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat(loop): enforce scalping TP/SL caps when regime=Scalping"
```

---

### Task 5: Add `strategy_type` to trade_executions (DB migration)

**Files:**
- Migration via Supabase MCP

**Purpose:** Mark every trade with its strategy type so scalp trades are visually distinct in dashboard and never confused with swing trades during review.

**Step 1: Apply migration via MCP**

```sql
ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS strategy_type TEXT DEFAULT 'swing';
```

Run this via `mcp__supabase__apply_migration` with name `add_strategy_type_to_trade_executions`.

**Step 2: Update `src/db/types.ts`**

Find `DbTradeExecution` interface, add:
```typescript
strategy_type?: string;
```

**Step 3: Update `src/db/repository.ts`**

Find `insertTradeExecution` function. Add `strategy_type` to the INSERT:
```typescript
// In INSERT columns list, add: strategy_type
// In VALUES list, add: $N (next param number)
// In params array, add: data.strategy_type ?? 'swing'
```

**Step 4: Pass strategy_type from TradingLoop**

In `src/trading-loop.ts`, find where `insertTradeExecution` is called (around line 754–770). Add:
```typescript
strategy_type: marketRegime === MarketRegime.Scalping ? 'scalping' : 'swing',
```

**Step 5: Run tests**

```bash
npx vitest run
```

**Step 6: Commit**

```bash
git add src/db/types.ts src/db/repository.ts src/trading-loop.ts
git commit -m "feat(db): add strategy_type to trade_executions — marks scalp vs swing trades"
```

---

### Task 6: Dashboard — show strategy badge on Trades page

**Files:**
- Modify: `dashboard/src/pages/Trades.tsx`

**Step 1: Find trade rows in Trades page**

Look for where trade data is rendered. Add a badge next to pair name:

```tsx
{trade.strategy_type === 'scalping' && (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">
    SCALP
  </span>
)}
```

**Step 2: Build dashboard**

```bash
cd dashboard && npm run build
```
Expected: build succeeds

**Step 3: Commit + deploy**

```bash
cd ..
git add dashboard/src/pages/Trades.tsx
git commit -m "feat(dashboard): show SCALP badge on scalping trades"
git push
npm run deploy
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

```bash
npx vitest run
```
Expected: all 347+ tests pass

**Step 2: Check production logs after deploy**

```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'tail -20 ~/indic-bot/logs/decisions.jsonl'
```

Look for decisions with regime `Scalping`. In Capitulation/low-volume markets, you should now see `"regime": "Scalping"` in decision logs instead of filter warnings.

**Step 3: Verify DB**

```sql
SELECT strategy_type, COUNT(*) FROM trade_executions GROUP BY strategy_type;
```

---

## Key Notes for Implementer

- **TypeScript ESM** — all imports use `.js` extension
- **MarketRegime.Scalping** priority: after BearTrend, before Range (it catches low-volume conditions that would otherwise fall into Range)
- **leverageMultiplier: 0.1** — if `maxLeverage: 20` in config, max scalping leverage = 2x
- **strategy_type default = 'swing'** — existing trades are unaffected
- **Capitulation takes priority** — F&G < 15 always wins over Scalping detection
- **Run** `npx vitest run` after every task before committing
