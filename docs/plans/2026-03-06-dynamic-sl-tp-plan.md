# Dynamic SL/TP + Bug Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let LLM dynamically adjust SL/TP on open positions each Brain cycle, with ratchet guardrails that prevent lowering protection. Also fix 2 DB bugs (trade_closes.execution_id NULL, swarm cycle_id NULL).

**Architecture:** New `ADJUST` action in TradeDecision. Each cycle, LLM sees current SL/TP + PnL and can return ADJUST to move them. RiskManager enforces ratchet rule (SL only rises). OrderExecutor cancels old algo orders and places new ones. DB tracks all adjustments.

**Tech Stack:** TypeScript ESM (.js imports), Vitest, Binance Futures API (algo orders), PostgreSQL/Supabase

---

### Task 1: Fix trade_closes.execution_id NULL bug

The bot inserts trade closes without `execution_id`, causing `get_open_positions()` to show closed positions as open.

**Files:**
- Modify: `src/trading-loop.ts:862-871`
- Modify: `src/db/repository.ts:358-375` (getOpenPositionContexts query also needs fix)
- Test: `tests/trading-loop.test.ts`

**Step 1: Find the execution_id before inserting close**

In `src/trading-loop.ts`, the CLOSE handler (line 837-892) doesn't look up the execution ID. Add a query to find it.

At line 862, before the `insertTradeClose` call, add:

```typescript
// Look up execution_id for this position
let executionId: number | undefined;
try {
  const posCtx = positionContexts.find(c => c.pair === decision.pair);
  if (posCtx && (posCtx as any).id) {
    executionId = (posCtx as any).id;
  }
} catch {}
```

Then modify the `insertTradeClose` call at line 863 to include `execution_id: executionId`:

```typescript
insertTradeClose({
  execution_id: executionId,  // <-- ADD THIS
  pair: decision.pair,
  exit_reason: 'LLM_CLOSE',
  pnl_usd: parseFloat(pnlUsd.toFixed(2)),
  pnl_pct: pos.unrealizedPnlPct,
  held_hours: pos.heldHours,
  order_id: result.orderId,
  close_decision_id: decisionId,
}).catch(e => console.error('[DB] close insert error:', e.message));
```

**Step 2: Update getOpenPositionContexts to return `id`**

In `src/db/repository.ts:362`, add `te.id` to the SELECT:

```typescript
`SELECT DISTINCT ON (te.pair)
        te.id, te.pair, te.side, te.fill_price, te.sl_price, te.tp_price,
        te.entry_thesis, te.leverage, te.size_usd, te.opened_at
 FROM trade_executions te
 LEFT JOIN trade_closes tc ON tc.execution_id = te.id
 WHERE te.pair IN (${placeholders})
   AND tc.id IS NULL
   AND te.fill_price IS NOT NULL
   AND te.opened_at > NOW() - INTERVAL '48 hours'
 ORDER BY te.pair, te.opened_at DESC`,
```

Also update the `OpenPositionContext` interface (around line 330) to include `id`:

```typescript
export interface OpenPositionContext {
  id: number;  // <-- ADD
  pair: string;
  side: string;
  fill_price: number;
  sl_price: number;
  tp_price: number;
  entry_thesis: string;
  leverage: number;
  size_usd: number;
  opened_at: string;
}
```

**Step 3: Also fix auto-exit close (line 216-258)**

The auto-exit block also calls `insertTradeClose` without execution_id. It doesn't have positionContexts in scope but can look it up the same way. However, auto-exits happen before the LLM call, so positionContexts may not be fetched yet.

Simpler fix: move the `getOpenPositionContexts` call before the auto-exit block, or just skip — auto-exits are rare and can be matched by pair+time. **Skip for now** (YAGNI).

**Step 4: Run tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/trading-loop.ts src/db/repository.ts
git commit -m "fix: pass execution_id to insertTradeClose for proper position tracking"
```

---

### Task 2: DB migration — sl_tp_adjustments table

**Files:**
- Create migration via Supabase MCP

**Step 1: Create the table**

Run this SQL migration:

```sql
CREATE TABLE sl_tp_adjustments (
  id SERIAL PRIMARY KEY,
  cycle_id INT REFERENCES cycles(id),
  execution_id INT REFERENCES trade_executions(id),
  pair TEXT NOT NULL,
  side TEXT NOT NULL,
  old_sl NUMERIC,
  new_sl NUMERIC,
  old_tp NUMERIC,
  new_tp NUMERIC,
  reasoning TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sl_tp_adj_pair ON sl_tp_adjustments(pair);
CREATE INDEX idx_sl_tp_adj_cycle ON sl_tp_adjustments(cycle_id);
```

**Step 2: Verify**

```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sl_tp_adjustments';
```

---

### Task 3: Add ADJUST to TradeDecision type + RiskManager validation

**Files:**
- Modify: `src/risk/manager.ts:1-11` (TradeDecision interface)
- Modify: `src/risk/manager.ts:57-159` (validate method)
- Test: `tests/risk/manager.test.ts`

**Step 1: Write the failing tests**

Add to `tests/risk/manager.test.ts`:

```typescript
describe('ADJUST validation', () => {
  const basePortfolio: PortfolioState = {
    balanceUsd: 1000,
    availableUsd: 800,
    positions: [{
      pair: 'ADAUSDT',
      sizeUsd: 200,
      leverage: 5,
      side: 'SHORT',
      entryPrice: 0.27,
      unrealizedPnlPct: 8.0,
      heldHours: 2,
    }],
    sessionPnl: 0,
    drawdownPct: 0,
  };

  it('approves ADJUST that tightens SL (ratchet up for SHORT)', () => {
    const decision: TradeDecision = {
      pair: 'ADAUSDT',
      action: 'ADJUST',
      size_pct: 0,
      leverage: 5,
      stop_loss_pct: 1.5,  // tighter than original 2.2
      take_profit_pct: 5.0,
      reasoning: 'locking profit',
    };
    const result = rm.validate(decision, basePortfolio, undefined, {
      currentSlPrice: 0.2759,  // original SL (2.2% above entry)
      currentTpPrice: 0.2495,  // original TP
      entryPrice: 0.27,
      side: 'SHORT',
    });
    expect(result.approved).toBe(true);
  });

  it('rejects ADJUST that loosens SL (violates ratchet)', () => {
    const decision: TradeDecision = {
      pair: 'ADAUSDT',
      action: 'ADJUST',
      size_pct: 0,
      leverage: 5,
      stop_loss_pct: 3.0,  // wider than current 2.2 — ratchet violation
      take_profit_pct: 5.0,
      reasoning: 'give more room',
    };
    const result = rm.validate(decision, basePortfolio, undefined, {
      currentSlPrice: 0.2759,
      currentTpPrice: 0.2495,
      entryPrice: 0.27,
      side: 'SHORT',
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('ratchet');
  });

  it('enforces breakeven lock when PnL >= 5%', () => {
    const decision: TradeDecision = {
      pair: 'ADAUSDT',
      action: 'ADJUST',
      size_pct: 0,
      leverage: 5,
      stop_loss_pct: 1.0,  // SL 1% above entry for SHORT = 0.2727
      take_profit_pct: 5.0,
      reasoning: 'partial lock',
    };
    // PnL is 8% — breakeven lock should require SL at or below entry
    const result = rm.validate(decision, basePortfolio, undefined, {
      currentSlPrice: 0.2759,
      currentTpPrice: 0.2495,
      entryPrice: 0.27,
      side: 'SHORT',
    });
    // For SHORT, SL above entry = 0.27 + 1% = 0.2727 — this is ABOVE entry
    // Breakeven lock means SL must be AT or BELOW entry for SHORT
    // stop_loss_pct=1.0 means SL at entry+1% = above entry = loss zone
    // So this should be rejected
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('breakeven');
  });

  it('approves ADJUST with profit-lock SL (negative stop_loss_pct)', () => {
    const decision: TradeDecision = {
      pair: 'ADAUSDT',
      action: 'ADJUST',
      size_pct: 0,
      leverage: 5,
      stop_loss_pct: -3.0,  // SL 3% below entry for SHORT = locks 3% profit
      take_profit_pct: 5.0,
      reasoning: 'lock 3% profit',
    };
    const result = rm.validate(decision, basePortfolio, undefined, {
      currentSlPrice: 0.2759,
      currentTpPrice: 0.2495,
      entryPrice: 0.27,
      side: 'SHORT',
    });
    expect(result.approved).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: FAIL — `ADJUST` not recognized, `AdjustContext` not defined

**Step 3: Implement ADJUST in TradeDecision and RiskManager**

In `src/risk/manager.ts`, update `TradeDecision`:

```typescript
export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
  confidence?: number;
  regime_override?: string;
}

export interface AdjustContext {
  currentSlPrice: number;
  currentTpPrice: number;
  entryPrice: number;
  side: 'LONG' | 'SHORT';
}
```

Update the `validate` method signature:

```typescript
validate(decision: TradeDecision, portfolio: PortfolioState, ctx?: ValidationContext, adjustCtx?: AdjustContext): ValidationResult {
```

At the top of validate, after the HOLD/CLOSE/FETCH_NEWS check (line 58), add ADJUST handling:

```typescript
if (decision.action === 'ADJUST') {
  if (!adjustCtx) {
    return { approved: false, reason: 'ADJUST requires position context' };
  }

  const { currentSlPrice, entryPrice, side } = adjustCtx;
  const newSlPct = decision.stop_loss_pct;

  // Calculate new SL price
  // Positive stop_loss_pct = SL in loss zone (normal)
  // Negative stop_loss_pct = SL in profit zone (profit lock)
  const newSlPrice = side === 'LONG'
    ? entryPrice * (1 - newSlPct / 100)
    : entryPrice * (1 + newSlPct / 100);

  // Ratchet rule: SL can only improve (rise for LONG, fall for SHORT)
  if (side === 'LONG' && newSlPrice < currentSlPrice) {
    return { approved: false, reason: `Ratchet violation: new SL $${newSlPrice.toFixed(4)} < current $${currentSlPrice.toFixed(4)}` };
  }
  if (side === 'SHORT' && newSlPrice > currentSlPrice) {
    return { approved: false, reason: `Ratchet violation: new SL $${newSlPrice.toFixed(4)} > current $${currentSlPrice.toFixed(4)}` };
  }

  // Breakeven lock: if position PnL >= 5%, SL must be at or beyond entry
  const pos = portfolio.positions.find(p => p.pair === decision.pair);
  if (pos && pos.unrealizedPnlPct >= 5) {
    if (side === 'LONG' && newSlPrice < entryPrice) {
      return { approved: false, reason: `Breakeven lock: PnL ${pos.unrealizedPnlPct.toFixed(1)}% >= 5% but SL ($${newSlPrice.toFixed(4)}) below entry ($${entryPrice.toFixed(4)})` };
    }
    if (side === 'SHORT' && newSlPrice > entryPrice) {
      return { approved: false, reason: `Breakeven lock: PnL ${pos.unrealizedPnlPct.toFixed(1)}% >= 5% but SL ($${newSlPrice.toFixed(4)}) above entry ($${entryPrice.toFixed(4)})` };
    }
  }

  return { approved: true };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts
git commit -m "feat: add ADJUST action with ratchet guardrail and breakeven lock"
```

---

### Task 4: Add OrderExecutor.adjustSlTp() method

**Files:**
- Modify: `src/binance/orders.ts:110-152`
- Test: `tests/binance/orders.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/orders.test.ts`:

```typescript
describe('adjustSlTp', () => {
  it('cancels old algo orders and places new SL/TP', async () => {
    const cancelCalls: any[] = [];
    const algoOrders: any[] = [];

    const mockClient = {
      cancelAllAlgoOpenOrders: vi.fn().mockImplementation((p: any) => {
        cancelCalls.push(p);
        return Promise.resolve();
      }),
      submitNewAlgoOrder: vi.fn().mockImplementation((p: any) => {
        algoOrders.push(p);
        return Promise.resolve({ orderId: 123 });
      }),
    };

    const executor = new OrderExecutor(mockClient);
    const result = await executor.adjustSlTp({
      pair: 'ADAUSDT',
      side: 'SHORT',
      newSlPrice: 0.265,
      newTpPrice: 0.250,
    });

    expect(result.success).toBe(true);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].symbol).toBe('ADAUSDT');
    expect(algoOrders).toHaveLength(2);
    // SL for SHORT: BUY side STOP_MARKET
    expect(algoOrders[0].side).toBe('BUY');
    expect(algoOrders[0].type).toBe('STOP_MARKET');
    expect(algoOrders[1].type).toBe('TAKE_PROFIT_MARKET');
  });

  it('returns failure if new SL placement fails', async () => {
    const mockClient = {
      cancelAllAlgoOpenOrders: vi.fn().mockResolvedValue(undefined),
      submitNewAlgoOrder: vi.fn()
        .mockRejectedValueOnce(new Error('SL failed'))  // SL fails
        .mockResolvedValueOnce({ orderId: 456 }),        // TP would succeed
    };

    const executor = new OrderExecutor(mockClient);
    const result = await executor.adjustSlTp({
      pair: 'ADAUSDT',
      side: 'SHORT',
      newSlPrice: 0.265,
      newTpPrice: 0.250,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SL failed');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: FAIL — `adjustSlTp` not defined

**Step 3: Implement adjustSlTp**

Add to `src/binance/orders.ts` after the `close()` method (line 141):

```typescript
async adjustSlTp(params: {
  pair: string;
  side: 'LONG' | 'SHORT';
  newSlPrice: number;
  newTpPrice: number;
}): Promise<OrderResult> {
  const { pair, side, newSlPrice, newTpPrice } = params;
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

  try {
    // 1. Cancel all existing algo orders for this pair
    try {
      await this.client.cancelAllAlgoOpenOrders({ symbol: pair });
    } catch {
      // May have no algo orders — continue
    }

    // 2. Place new SL (mandatory — fail = abort adjustment)
    await this.client.submitNewAlgoOrder({
      symbol: pair,
      side: closeSide,
      algoType: 'CONDITIONAL',
      type: 'STOP_MARKET',
      triggerPrice: String(this.roundPrice(newSlPrice)),
      closePosition: 'true',
    });

    // 3. Place new TP (best-effort)
    try {
      await this.client.submitNewAlgoOrder({
        symbol: pair,
        side: closeSide,
        algoType: 'CONDITIONAL',
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: String(this.roundPrice(newTpPrice)),
        closePosition: 'true',
      });
    } catch (tpErr: any) {
      console.error(`[Orders] TP adjustment failed for ${pair}: ${tpErr.message}`);
    }

    console.log(`[Orders] Adjusted ${pair} ${side}: SL→$${newSlPrice.toFixed(4)}, TP→$${newTpPrice.toFixed(4)}`);
    return { success: true, slPrice: newSlPrice, tpPrice: newTpPrice };
  } catch (err: any) {
    console.error(`[Orders] SL adjustment FAILED for ${pair}: ${err.message}`);
    return { success: false, error: `Adjust SL failed: ${err.message}` };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "feat: add OrderExecutor.adjustSlTp() for dynamic SL/TP modification"
```

---

### Task 5: Add DB types + repository for sl_tp_adjustments

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/repository.ts`

**Step 1: Add the interface to types.ts**

At the end of `src/db/types.ts` (after `DbMarketSnapshot`):

```typescript
export interface DbSlTpAdjustment {
  id?: number;
  cycle_id?: number;
  execution_id?: number;
  pair: string;
  side: string;
  old_sl?: number;
  new_sl?: number;
  old_tp?: number;
  new_tp?: number;
  reasoning?: string;
  created_at?: string;
}
```

**Step 2: Add insertSlTpAdjustment to repository.ts**

```typescript
export async function insertSlTpAdjustment(a: Omit<DbSlTpAdjustment, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO sl_tp_adjustments (cycle_id, execution_id, pair, side, old_sl, new_sl, old_tp, new_tp, reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [a.cycle_id, a.execution_id, a.pair, a.side, a.old_sl, a.new_sl, a.old_tp, a.new_tp, a.reasoning],
  );
  return rows[0].id;
}
```

**Step 3: Update trade_executions SL/TP after adjustment**

Add a function to update the execution record so `getOpenPositionContexts` returns current SL/TP:

```typescript
export async function updateExecutionSlTp(executionId: number, slPrice: number, tpPrice: number): Promise<void> {
  await q().query(
    `UPDATE trade_executions SET sl_price = $1, tp_price = $2 WHERE id = $3`,
    [slPrice, tpPrice, executionId],
  );
}
```

**Step 4: Commit**

```bash
git add src/db/types.ts src/db/repository.ts
git commit -m "feat: add sl_tp_adjustments DB type and repository functions"
```

---

### Task 6: Update LLM prompt to support ADJUST action

**Files:**
- Modify: `src/llm/prompts.ts:81-97` (decision format)
- Modify: `src/llm/prompts.ts:509-532` (position context display)

**Step 1: Add ADJUST to the JSON format**

In `src/llm/prompts.ts`, the system prompt decision format (line 86). Change:

```typescript
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
```

to:

```typescript
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD" | "ADJUST",
```

**Step 2: Add ADJUST instruction to system prompt**

After line 78 (`- Do NOT scalp. Target swing moves.`), add:

```typescript
- For open positions: use ADJUST to move SL/TP levels. SL can only tighten (protect more). When position is profitable, lock gains by moving SL closer to or above entry.
- ADJUST example: position +8% ROI, momentum fading → set stop_loss_pct to -3 (locks 3% profit) and take_profit_pct to 9
- Negative stop_loss_pct = profit lock (SL beyond entry in profitable direction)
```

**Step 3: Show adjustment guidance in position context**

In `src/llm/prompts.ts`, after line 529 (`prompt += '    >>> DO NOT close...`), add:

```typescript
          // Show ROI on margin for ADJUST context
          const marginRoi = pos.unrealizedPnlPct;
          if (marginRoi > 3) {
            prompt += `    Margin ROI: ${marginRoi > 0 ? '+' : ''}${marginRoi.toFixed(1)}% — consider ADJUST to lock profit\n`;
          }
```

**Step 4: Run existing tests**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: add ADJUST action to LLM prompt with profit-lock guidance"
```

---

### Task 7: Wire ADJUST handling in TradingLoop

This is the core integration — handle ADJUST decisions in the main loop.

**Files:**
- Modify: `src/trading-loop.ts:835-945` (decision execution block)
- Modify: `src/trading-loop.ts:29` (imports)
- Test: `tests/trading-loop.test.ts`

**Step 1: Add imports**

In `src/trading-loop.ts:29`, add `insertSlTpAdjustment` and `updateExecutionSlTp` to the import:

```typescript
import { insertCycle, insertTradeDecision, insertTradeExecution, insertTradeClose, insertRiskValidation, insertIndicatorSnapshot, insertLlmConversation, getOpenPositionContexts, getMarketSnapshotsSince, getRecentDecisions, insertSlTpAdjustment, updateExecutionSlTp } from './db/repository.js';
```

**Step 2: Add ADJUST handling in the decision loop**

In `src/trading-loop.ts`, in the decision execution block, after the CLOSE handler (around line 892) and before the LONG/SHORT handler (line 893 `} else {`), add an `else if` for ADJUST:

```typescript
        } else if (decision.action === 'ADJUST') {
          const pos = portfolio.positions.find(p => p.pair === decision.pair);
          const posCtx = positionContexts.find(c => c.pair === decision.pair);
          if (!pos || !posCtx) {
            console.log(`[Adjust] No open position or context for ${decision.pair} — skipping`);
            continue;
          }

          const adjustCtx: import('./risk/manager.js').AdjustContext = {
            currentSlPrice: Number(posCtx.sl_price),
            currentTpPrice: Number(posCtx.tp_price),
            entryPrice: Number(posCtx.fill_price),
            side: pos.side,
          };

          const adjustValidation = this.deps.riskManager.validate(decision, portfolio, validationCtx, adjustCtx);

          // Log to DB
          if (cycleId && decisionId) {
            insertRiskValidation({
              decision_id: decisionId,
              passed: adjustValidation.approved,
              rejection_reason: adjustValidation.reason,
            }).catch(() => {});
          }

          if (!adjustValidation.approved) {
            console.log(`[Adjust] Rejected for ${decision.pair}: ${adjustValidation.reason}`);
            continue;
          }

          // Calculate new absolute prices
          const entryPrice = Number(posCtx.fill_price);
          const newSlPrice = pos.side === 'LONG'
            ? entryPrice * (1 - decision.stop_loss_pct / 100)
            : entryPrice * (1 + decision.stop_loss_pct / 100);
          const newTpPrice = pos.side === 'LONG'
            ? entryPrice * (1 + decision.take_profit_pct / 100)
            : entryPrice * (1 - decision.take_profit_pct / 100);

          const result = await orders.adjustSlTp({
            pair: decision.pair,
            side: pos.side,
            newSlPrice,
            newTpPrice,
          });

          if (result.success) {
            console.log(`[Adjust] ${decision.pair}: SL $${adjustCtx.currentSlPrice.toFixed(4)}→$${newSlPrice.toFixed(4)}, TP $${adjustCtx.currentTpPrice.toFixed(4)}→$${newTpPrice.toFixed(4)}`);

            // Update execution record so next cycle sees current SL/TP
            if ((posCtx as any).id) {
              updateExecutionSlTp((posCtx as any).id, newSlPrice, newTpPrice).catch(() => {});
            }

            // Log adjustment
            if (cycleId) {
              insertSlTpAdjustment({
                cycle_id: cycleId,
                execution_id: (posCtx as any).id,
                pair: decision.pair,
                side: pos.side,
                old_sl: adjustCtx.currentSlPrice,
                new_sl: newSlPrice,
                old_tp: adjustCtx.currentTpPrice,
                new_tp: newTpPrice,
                reasoning: decision.reasoning,
              }).catch(() => {});
            }

            this.deps.memory.setLastOrderResult(
              `${decision.pair} ADJUST — SL→$${newSlPrice.toFixed(4)}, TP→$${newTpPrice.toFixed(4)}: ${decision.reasoning}`
            );
          } else {
            console.error(`[Adjust] Failed for ${decision.pair}: ${result.error}`);
            logger.logError('ADJUST_FAIL', result.error || 'Unknown');
          }
```

**Step 3: Make sure `validationCtx` is available**

The variable `validationCtx` (with indicators4h, fearGreed) is already constructed earlier in the loop. Verify it's in scope where the decision loop runs. Check that the existing code at line ~770 creates it — it should be something like:

```typescript
const validationCtx = { indicators4h, fearGreed: fgData, fearGreedLeverageCap: ... };
```

If it's scoped inside a different block, move the reference.

**Step 4: Run tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat: wire ADJUST action handling in TradingLoop"
```

---

### Task 8: LLM response parsing — handle ADJUST action

**Files:**
- Modify: `src/llm/client.ts` (JSON parse logic)
- Test: `tests/llm/client.test.ts`

**Step 1: Verify ADJUST is already handled**

The LLM response parser in `client.ts` extracts decisions from JSON. Check if it filters by action type. If it does (e.g., only allows LONG/SHORT/CLOSE/HOLD), add ADJUST to the allowed list.

Search for action validation in `src/llm/client.ts`:

```bash
grep -n "action.*LONG\|validAction\|allowedAction" src/llm/client.ts
```

If there's a filter like:
```typescript
const validActions = ['LONG', 'SHORT', 'CLOSE', 'HOLD', 'FETCH_NEWS'];
```

Add `'ADJUST'` to it.

**Step 2: Run tests**

Run: `npx vitest run tests/llm/client.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/llm/client.ts tests/llm/client.test.ts
git commit -m "feat: allow ADJUST action in LLM response parser"
```

---

### Task 9: Fix swarm cycle_id NULL (minor)

Some swarm conversations have `cycle_id = NULL` because the cycle hadn't been inserted yet when swarm started.

**Files:**
- Modify: `src/llm/swarm-agent.ts`

**Step 1: Check swarm-agent.ts for cycleId usage**

The `SwarmAgent` has `this.cycleId` which is set from `LLMClient.cycleId`. The issue is that `cycleId` is set AFTER `insertCycle()` in the trading loop, but the swarm starts before that or uses a stale value.

Check in `src/trading-loop.ts` — where is `cycleId` set vs where swarm is called?

The fix: ensure `this.deps.llm.cycleId = cycleId` is set BEFORE calling swarm/analyze. This should already be the case, but if `cycleId` is sometimes undefined (e.g., `insertCycle` failed), the swarm gets NULL.

**Step 2: Add defensive logging**

In `src/llm/swarm-agent.ts:316`, add a log if cycleId is null:

```typescript
if (!this.cycleId) {
  console.warn('[Swarm] WARNING: cycleId is null — swarm conversation will not be linked to cycle');
}
```

**Step 3: Check trading-loop.ts order of operations**

Verify that `insertCycle()` happens before swarm/analyze and that `this.deps.llm.cycleId = cycleId` is set. If not, reorder.

**Step 4: Commit**

```bash
git add src/llm/swarm-agent.ts src/trading-loop.ts
git commit -m "fix: ensure swarm conversations get cycle_id"
```

---

### Task 10: Integration test — full ADJUST flow

**Files:**
- Test: `tests/trading-loop.test.ts`

**Step 1: Write integration test**

Add a test that mocks:
- LLM returning an ADJUST decision
- RiskManager approving it
- OrderExecutor.adjustSlTp being called with correct prices
- DB functions being called

```typescript
it('handles ADJUST decision — moves SL/TP', async () => {
  // Mock LLM returns ADJUST for ADA
  mockLlm.analyze.mockResolvedValueOnce([
    {
      pair: 'ADAUSDT',
      action: 'ADJUST',
      size_pct: 0,
      leverage: 5,
      stop_loss_pct: -2.0,  // lock 2% profit
      take_profit_pct: 8.0,
      reasoning: 'momentum fading, lock profit',
      confidence: 70,
    },
  ]);

  // Mock portfolio with open position
  mockMarketData.getPortfolioState.mockResolvedValueOnce({
    balanceUsd: 180,
    availableUsd: 150,
    positions: [{
      pair: 'ADAUSDT',
      sizeUsd: 200,
      leverage: 5,
      side: 'SHORT',
      entryPrice: 0.27,
      unrealizedPnlPct: 6.0,
      heldHours: 3,
    }],
    sessionPnl: 0,
    drawdownPct: 0,
  });

  await loop.runOnce();

  expect(mockOrders.adjustSlTp).toHaveBeenCalledWith(expect.objectContaining({
    pair: 'ADAUSDT',
    side: 'SHORT',
  }));
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/trading-loop.test.ts
git commit -m "test: integration test for ADJUST flow in TradingLoop"
```
