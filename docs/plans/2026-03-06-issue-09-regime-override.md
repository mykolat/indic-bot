# Issue #9: regime_override from LLM logged but never applied

## Problem

The LLM can output `regime_override` in its trade decision (defined in `src/risk/manager.ts` line 10, prompted in `src/llm/prompts.ts` line 94). This field is:

1. **Stored** in the DB via `insertTradeDecision()` (line 819 of `src/trading-loop.ts`)
2. **Logged** in the Decision Journal (line 689 of `src/trading-loop.ts`)

But it is **never applied**. The `marketRegime` variable (set at line 398 of `src/trading-loop.ts` from `classifyRegime()`) is never overwritten, so:

- `activeProfile` (line 400) always uses the algorithmic regime
- `leverageMultiplier` (line 972) uses the algorithmic regime
- `slStyle`/`tpStyle` use the algorithmic regime (once Issue #8 is wired)
- `filterWarning` (line 490) uses the algorithmic regime

The LLM prompt explicitly says: *"If your narrative reading strongly contradicts this regime, use the 'regime_override' field to change it."* (line 242 of `src/llm/prompts.ts`) — but the field is dead code.

## Root Cause

The regime classification happens at line 394–402 of `src/trading-loop.ts`, before the LLM is called. After the LLM responds (line 580), decisions are iterated and `regime_override` is logged but never used to update `marketRegime` or `activeProfile` for the decision processing loop.

## Solution

After parsing the LLM decisions, check if any decision contains a `regime_override`. If it does, and the override is a valid `MarketRegime` value, update `marketRegime` and `activeProfile` for the remainder of that cycle's decision processing. Log the override.

### Design Decisions

1. **Per-cycle, not per-decision:** If the LLM overrides the regime, it applies to ALL decisions in that cycle. The LLM sees the full market picture — if it says "this is a Breakout," all decisions should be processed with Breakout filters.
2. **Validation:** Only accept valid `MarketRegime` enum values. Reject garbage strings silently.
3. **Confidence threshold:** Only accept override if the decision's `confidence >= 60`. Low-confidence overrides are noise.
4. **DB tracking:** Store both original and overridden regime in the cycle record for post-analysis.

## Files to Modify

| File | Change |
|------|--------|
| `src/trading-loop.ts` | Apply `regime_override` after LLM response, before decision processing |
| `tests/trading-loop.test.ts` | Test that override changes activeProfile and is logged |

## Implementation Steps (TDD)

### Step 1: Write failing test — regime_override changes activeProfile

```typescript
// tests/trading-loop.test.ts — add test

it('applies regime_override from LLM decision', async () => {
  // LLM returns a decision with regime_override = 'Breakout'
  mockLlm.analyze.mockResolvedValue([
    {
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 5,
      stop_loss_pct: 2,
      take_profit_pct: 4,
      reasoning: 'breakout imminent',
      confidence: 75,
      regime_override: 'Breakout',
    },
  ]);

  await loop.runOnce();

  // Verify the order was executed (not blocked by filters)
  expect(mockOrders.execute).toHaveBeenCalled();

  // Verify the decision journal logged the override
  // The regime in the journal entry should reflect the override
  // (We check via the logger's decision log)
  const loggedDecision = mockLogger.logDecision.mock.calls.find(
    (call: any[]) => call[0]?.type === 'LLM_DECISION'
  );
  expect(loggedDecision).toBeDefined();
});
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — this test passes currently (it's a baseline) but does not verify the override mechanism. The next test will be more specific.

### Step 2: Write test that verifies override changes regime for leverage multiplier

```typescript
// tests/trading-loop.test.ts — add test

it('regime_override=Capitulation applies 0.25x leverage multiplier', async () => {
  // Default regime from classifyRegime will be Range or BullTrend (from mock candles).
  // Override to Capitulation (leverageMultiplier = 0.25)
  mockLlm.analyze.mockResolvedValue([
    {
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 20,
      stop_loss_pct: 2,
      take_profit_pct: 4,
      reasoning: 'capitulation bounce',
      confidence: 70,
      regime_override: 'Capitulation',
    },
  ]);

  await loop.runOnce();

  expect(mockOrders.execute).toHaveBeenCalled();
  const executedDecision = mockOrders.execute.mock.calls[0][0];
  // Capitulation leverageMultiplier = 0.25, so leverage 20 * 0.25 = 5
  expect(executedDecision.leverage).toBe(5);
});
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — fails because `regime_override` is never applied, so leverage is not multiplied by Capitulation's 0.25x.

### Step 3: Write test that invalid regime_override is ignored

```typescript
// tests/trading-loop.test.ts — add test

it('ignores invalid regime_override values', async () => {
  mockLlm.analyze.mockResolvedValue([
    {
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 10,
      stop_loss_pct: 2,
      take_profit_pct: 4,
      reasoning: 'random override',
      confidence: 80,
      regime_override: 'SuperBull',  // not a valid MarketRegime
    },
  ]);

  await loop.runOnce();

  expect(mockOrders.execute).toHaveBeenCalled();
  const executedDecision = mockOrders.execute.mock.calls[0][0];
  // Leverage should NOT be modified by invalid override
  // (The default regime from indicators will apply its own multiplier)
  expect(executedDecision.leverage).toBeGreaterThanOrEqual(1);
});
```

### Step 4: Write test that low-confidence override is ignored

```typescript
// tests/trading-loop.test.ts — add test

it('ignores regime_override when confidence < 60', async () => {
  mockLlm.analyze.mockResolvedValue([
    {
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 20,
      stop_loss_pct: 2,
      take_profit_pct: 4,
      reasoning: 'low confidence override',
      confidence: 45,
      regime_override: 'Capitulation',
    },
  ]);

  await loop.runOnce();

  expect(mockOrders.execute).toHaveBeenCalled();
  const executedDecision = mockOrders.execute.mock.calls[0][0];
  // Override should be ignored due to low confidence
  // So leverage should NOT be 20 * 0.25 = 5
  // (It will be whatever the algorithmic regime's multiplier gives)
  expect(executedDecision.leverage).not.toBe(5);
});
```

### Step 5: Implement regime_override application

In `src/trading-loop.ts`, after the LLM response is obtained (after line 581, before the `for (const decision of decisions)` loop at line 676), add:

```typescript
// src/trading-loop.ts — after decisions are obtained (after line 581), before decision loop (line 676)

// Apply regime_override if any decision requests it
const overrideDecision = decisions.find(
  d => d.regime_override && (d.confidence ?? 50) >= 60
);
if (overrideDecision?.regime_override) {
  const overrideValue = overrideDecision.regime_override;
  const validRegimes = Object.values(MarketRegime) as string[];
  if (validRegimes.includes(overrideValue)) {
    const originalRegime = marketRegime;
    marketRegime = overrideValue as MarketRegime;
    activeProfile = getFilterProfile(marketRegime);
    console.log(`[RegimeOverride] LLM overrode regime: ${originalRegime} → ${marketRegime} (confidence: ${overrideDecision.confidence}, reason: ${overrideDecision.reasoning.slice(0, 100)})`);
  } else {
    console.log(`[RegimeOverride] Ignoring invalid regime_override: "${overrideValue}"`);
  }
}
```

Note: `MarketRegime` is already imported at line 22. `marketRegime` (line 390) and `activeProfile` (line 392) are `let` variables so they can be reassigned.

**Verify:** `npx vitest run tests/trading-loop.test.ts` — the Capitulation leverage test now passes (leverage 20 * 0.25 = 5). The invalid override test passes (no crash). The low-confidence test passes (override ignored).

### Step 6: Add logging to DB cycle record

To track overrides in the DB, update the cycle record. The `insertCycle()` call happens before the LLM (line 533). We need to update it after the override is applied. Add after the override block:

```typescript
// src/trading-loop.ts — after the regime override block

// Update cycle record with overridden regime if changed
if (overrideDecision?.regime_override && cycleId) {
  try {
    await q().query(
      `UPDATE cycles SET regime = $1, filter_warning = COALESCE(filter_warning, '') || $2 WHERE id = $3`,
      [marketRegime, ` [regime_override: ${overrideDecision.regime_override}]`, cycleId],
    );
  } catch { /* DB update is best-effort */ }
}
```

However, this requires importing `q()` from the DB connection or using a repository function. A simpler approach: add a new repository function.

In `src/db/repository.ts`, add:

```typescript
export async function updateCycleRegime(cycleId: number, regime: string, note: string): Promise<void> {
  await q().query(
    `UPDATE cycles SET regime = $1, filter_warning = COALESCE(filter_warning, '') || $2 WHERE id = $3`,
    [regime, note, cycleId],
  );
}
```

Then import and use it in `src/trading-loop.ts`:

```typescript
import { ..., updateCycleRegime } from './db/repository.js';

// After the override block:
if (overrideDecision?.regime_override && cycleId && validRegimes.includes(overrideDecision.regime_override)) {
  updateCycleRegime(cycleId, marketRegime, ` [override from ${originalRegime}]`).catch(() => {});
}
```

### Step 7: Run full test suite and commit

```bash
npx vitest run tests/trading-loop.test.ts
git add src/trading-loop.ts src/db/repository.ts tests/trading-loop.test.ts
git commit -m "feat(issue-9): apply LLM regime_override to change active FilterProfile"
```

## Verification

After deployment:

1. **Logs:** Look for `[RegimeOverride] LLM overrode regime:` messages — they should appear occasionally when the LLM disagrees with the algorithmic classification.
2. **DB:** `SELECT regime, regime_override, filter_warning FROM trade_decisions WHERE regime_override IS NOT NULL;` — verify that overrides are logged.
3. **DB cycles:** `SELECT regime, filter_warning FROM cycles WHERE filter_warning LIKE '%override%';` — verify the cycle record reflects the override.
4. **Impact:** Compare leverage and SL/TP of trades where override was applied vs not — the override should change the FilterProfile behavior.
