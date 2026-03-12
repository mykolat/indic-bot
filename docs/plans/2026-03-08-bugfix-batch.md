# Bugfix Batch — P1+P2 Priority Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 bugs that directly impact P&L, data integrity, and cycle reliability.

**Architecture:** Targeted fixes in risk layer, LLM parsing, auto-exit logic, ghost reconciler, and swarm blackboard. Each fix is independent — no cross-dependencies.

**Tech Stack:** TypeScript, Vitest, Binance Futures API

---

## Task 1: P1.2 — `update.risks is not iterable` (Swarm Blackboard)

**Files:**
- Modify: `src/llm/swarm-blackboard.ts:113`
- Test: `tests/llm/swarm-blackboard.test.ts` (new test)

**Problem:** LLM sometimes returns `risks` as a string or null instead of array. `for (const r of update.risks)` crashes, killing the entire cycle.

**Step 1: Write the failing test**

In `tests/llm/swarm-blackboard.test.ts`, add:

```typescript
it('handles non-array risks gracefully', () => {
  const bb = new SwarmBlackboard(/* ... */);
  // Should not throw when risks is string/null/undefined
  expect(() => bb.mergePersonaUpdate('RM', {
    signals: { bullish: [], bearish: [], neutral: [] },
    vote: { action: 'HOLD', conviction: 'medium', reasoning: 'test' },
    risks: 'high volatility' as any,  // LLM returns string instead of array
    conflicts_with: {},
  })).not.toThrow();

  expect(() => bb.mergePersonaUpdate('BT', {
    signals: { bullish: [], bearish: [], neutral: [] },
    vote: { action: 'LONG', conviction: 'high', reasoning: 'test' },
    risks: null as any,
    conflicts_with: {},
  })).not.toThrow();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/swarm-blackboard.test.ts`
Expected: FAIL — `update.risks is not iterable`

**Step 3: Fix `mergePersonaUpdate` in `src/llm/swarm-blackboard.ts`**

Replace line 113:
```typescript
// Before:
for (const r of update.risks) addUnique(this.state.risks, r);

// After:
const risks = Array.isArray(update.risks) ? update.risks : (typeof update.risks === 'string' ? [update.risks] : []);
for (const r of risks) addUnique(this.state.risks, r);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/swarm-blackboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-blackboard.ts tests/llm/swarm-blackboard.test.ts
git commit -m "fix(swarm): guard against non-array risks in persona update"
```

---

## Task 2: P1.1 — ADJUST SL breakeven needs buffer

**Files:**
- Modify: `src/risk/sl-tightening-rules.ts:44`
- Modify: `tests/risk/sl-tightening-rules.test.ts` (add test)

**Problem:** The breakeven tier (5-10% profit) sets `lockRatio = 0` → SL exactly at entry price. With slippage, this loses money. The `moveSlToBreakeven` function in orders.ts correctly uses `breakevenBufferPct` (0.1%), but the SL tightening rules don't — so ADJUST decisions can set SL exactly at entry.

**Fix:** Change breakeven tier to lock a small buffer (0.5% profit) instead of 0%.

**Step 1: Write the failing test**

In `tests/risk/sl-tightening-rules.test.ts`, add:

```typescript
it('breakeven tier locks small buffer above entry (LONG)', () => {
  const range = computeAllowedSlRange({
    side: 'LONG', entryPrice: 100, currentPrice: 107, atrPct: 1.5,
  });
  // 7% profit → breakeven tier (5-10%)
  expect(range.tier).toContain('breakeven');
  // maxSlPrice must be ABOVE entry (not at entry)
  expect(range.maxSlPrice).toBeGreaterThan(100);
});

it('breakeven tier locks small buffer below entry (SHORT)', () => {
  const range = computeAllowedSlRange({
    side: 'SHORT', entryPrice: 100, currentPrice: 93, atrPct: 1.5,
  });
  expect(range.tier).toContain('breakeven');
  // maxSlPrice must be BELOW entry (not at entry)
  expect(range.maxSlPrice).toBeLessThan(100);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/sl-tightening-rules.test.ts`
Expected: FAIL — maxSlPrice equals entry (100)

**Step 3: Fix lockRatio in `src/risk/sl-tightening-rules.ts`**

Change line 44:
```typescript
// Before:
lockRatio = 0; // breakeven = lock 0% (SL at entry)

// After:
lockRatio = 0.05; // breakeven = lock 5% of profit (small buffer above entry)
```

This means for a SHORT at $83.15 with +5.4% profit:
- Profit distance = $4.49
- Lock 5% = $0.22 below entry
- SL at $82.93 instead of $83.15 — safe from slippage

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/risk/sl-tightening-rules.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/risk/sl-tightening-rules.ts tests/risk/sl-tightening-rules.test.ts
git commit -m "fix(risk): breakeven SL locks 5% profit buffer to prevent slippage loss"
```

---

## Task 3: P2.5 — Stale exit at +2.26% (wrong condition)

**Files:**
- Modify: `src/trading-loop.ts:430`
- Test: `tests/trading-loop-auto-exit.test.ts` (if exists, or add inline assertion)

**Problem:** Line 430 uses `Math.abs(pos.unrealizedPnlPct) < 1` — this checks absolute value. A position at +2.26% should NOT be stale (>1%), but LTC was closed as stale. The likely cause: `unrealizedPnlPct` was calculated differently at that moment (possible data inconsistency between Binance mark price fluctuations).

However, the real issue is that `Math.abs` also catches positions at -2.26%. A position deep in loss for 8h probably SHOULD be closed. But a profitable position should not.

**Fix:** Only auto-exit stale positions that are near breakeven or in loss. Profitable positions > 1% should be managed by LLM.

**Step 1: Change the stale condition**

In `src/trading-loop.ts`, change line 430:
```typescript
// Before:
} else if (pos.heldHours > staleHours && Math.abs(pos.unrealizedPnlPct) < 1) {

// After:
} else if (pos.heldHours > staleHours && pos.unrealizedPnlPct < 1) {
```

Remove `Math.abs` — now only closes if PnL < +1% (i.e. breakeven or losing). Positions at +2.26% won't be auto-closed.

**Step 2: Run tests**

Run: `npx vitest run tests/`
Expected: All pass

**Step 3: Commit**

```bash
git add src/trading-loop.ts
git commit -m "fix(auto-exit): only stale-close positions below +1% PnL (not profitable ones)"
```

---

## Task 4: P2.8/P2.11 — Ghost reconciler missing exit data

**Files:**
- Modify: `src/trading-loop.ts:405-416` (ghost reconciler section)
- Modify: `src/binance/market-data.ts` (add `getLastTrades` helper)

**Problem:** Ghost reconciler calls `insertTradeClose` with only `execution_id`, `pair`, `exit_reason` — no `exit_price`, `pnl_usd`, `pnl_pct`, `held_hours`. This explains AVAX and SOL having `exit_price: null` in DB.

**Fix:** Enrich ghost close records with data from Binance `getAccountTrades` (last fills for the pair).

**Step 1: Add getLastTrade helper to market-data.ts**

In `src/binance/market-data.ts`, add:

```typescript
async getLastTradeForPair(pair: string): Promise<{ price: number; time: number } | null> {
  try {
    const trades = await this.client.getAccountTrades({ symbol: pair, limit: 1 });
    if (trades.length > 0) {
      return { price: parseFloat((trades[0] as any).price), time: (trades[0] as any).time };
    }
  } catch { /* */ }
  return null;
}
```

**Step 2: Enrich ghost reconciler in trading-loop.ts**

Replace lines 405-416:
```typescript
try {
  const dbOpen = await getDbOpenPositions();
  const ghosts = detectGhostPositions(dbOpen, portfolio.positions);
  for (const ghost of ghosts) {
    console.log(`[Reconcile] Ghost position: ${ghost.pair} ${ghost.side} (exec #${ghost.id}) — closed on Binance, recording in DB`);

    // Try to get exit price from last trade
    const lastTrade = await marketData.getLastTradeForPair(ghost.pair);
    const exitPrice = lastTrade?.price;

    // Look up execution for held_hours and entry price
    let pnlUsd: number | undefined;
    let pnlPct: number | undefined;
    let heldHours: number | undefined;
    try {
      const { rows } = await q().query(
        'SELECT fill_price, leverage, quantity, created_at FROM trade_executions WHERE id = $1',
        [ghost.id]
      );
      if (rows[0] && exitPrice) {
        const entry = parseFloat(rows[0].fill_price);
        const qty = parseFloat(rows[0].quantity);
        const entryTime = new Date(rows[0].created_at).getTime();
        heldHours = (Date.now() - entryTime) / 3600000;
        const direction = ghost.side === 'BUY' ? 1 : -1;
        pnlUsd = (exitPrice - entry) * qty * direction;
        const margin = (entry * qty) / parseFloat(rows[0].leverage);
        pnlPct = margin > 0 ? (pnlUsd / margin) * 100 : undefined;
      }
    } catch { /* best effort */ }

    insertTradeClose({
      execution_id: ghost.id,
      pair: ghost.pair,
      exit_reason: 'sl_tp_triggered',
      exit_price: exitPrice,
      pnl_usd: pnlUsd,
      pnl_pct: pnlPct,
      held_hours: heldHours,
    }).catch(() => {});
  }
} catch (err: any) {
  console.error('[Reconcile] Error:', err?.message);
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/`
Expected: All pass

**Step 4: Commit**

```bash
git add src/trading-loop.ts src/binance/market-data.ts
git commit -m "fix(reconciler): enrich ghost closes with exit_price, pnl, held_hours from Binance"
```

---

## Task 5: P2.6 — PnL doesn't account for funding fees

**Files:**
- Modify: `src/db/repository.ts` (add `getFundingFeesForExecution` query)
- Modify: `src/trading-loop.ts` (include funding in close PnL)

**Problem:** `pnl_usd` in `trade_closes` records only realized PnL from trade, not funding fees paid/received during hold. For LTC: DB shows +$1.26, Binance shows +$0.92 — difference is -$0.34 in funding fees over 8.2h.

**Step 1: Add funding query to repository.ts**

```typescript
export async function getFundingForPair(pair: string, since: Date): Promise<number> {
  try {
    const { rows } = await q().query(
      `SELECT COALESCE(SUM((income->>'income')::numeric), 0) as total
       FROM income_history
       WHERE symbol = $1 AND income_type = 'FUNDING_FEE' AND created_at >= $2`,
      [pair, since]
    );
    return parseFloat(rows[0]?.total ?? '0');
  } catch {
    return 0;
  }
}
```

**Note:** This depends on having income_history table populated. If the table doesn't exist, this is a no-op enhancement that can be wired later. For now, the fix adds infrastructure without breaking anything.

**Step 2: Add `funding_fees_usd` column to trade_closes (migration)**

We won't add a migration now — just document the data gap. The primary fix is to make the bot log a note when funding fees are significant.

In the ghost reconciler (after computing pnlUsd), add:

```typescript
if (pnlUsd !== undefined) {
  console.log(`[Reconcile] ${ghost.pair}: PnL $${pnlUsd.toFixed(4)} (excl. funding fees)`);
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/`
Expected: All pass

**Step 4: Commit**

```bash
git add src/trading-loop.ts
git commit -m "fix(reconciler): log PnL note about funding fee exclusion"
```

---

## Task 6: P2.7 — Grok 410 Gone (graceful degradation)

**Files:**
- Modify: `src/llm/grok-client.ts`
- Modify: `src/news/grok-grounder.ts`

**Problem:** xAI deprecated live search. Grok calls with `web_search`/`x_search` tools return 410. Affects: GrokGrounder, DA search, narrative_expert search. FlashCrash works (no search tools).

**Fix:** Catch 410 errors and fall back to Grok without search tools. Log warning. Don't crash the cycle.

**Step 1: Add 410 handling to grok-client.ts**

In the main `call()` method, wrap the response handling:

```typescript
// After the API call, check for 410
if (response.status === 410) {
  console.warn(`[Grok] 410 Gone — search tools deprecated. Retrying without tools.`);
  // Retry without tools
  const retryBody = { ...body };
  delete retryBody.tools;
  const retryResponse = await fetch(url, { ...opts, body: JSON.stringify(retryBody) });
  // ... handle retry response
}
```

**Step 2: Update GrokGrounder to handle no-search gracefully**

In `src/news/grok-grounder.ts`, if Grok returns without search results:

```typescript
// If no tool_use in response, the grounding is best-effort (no live data)
if (!hasToolUse) {
  console.log(`[GrokGrounder] No search available — grounding based on model knowledge only`);
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/`
Expected: All pass

**Step 4: Commit**

```bash
git add src/llm/grok-client.ts src/news/grok-grounder.ts
git commit -m "fix(grok): graceful 410 fallback — retry without search tools"
```

---

## Task Dependency Graph

```
Task 1 (swarm risks)     — independent
Task 2 (SL buffer)       — independent
Task 3 (stale exit)      — independent
Task 4 (ghost enrichment) — independent
Task 5 (funding note)    — depends on Task 4 (same code area)
Task 6 (Grok 410)        — independent
```

All tasks except 5 are fully independent and can be parallelized.

---

## Verification Checklist

- [ ] `npx vitest run` — all tests pass
- [ ] `npm run build` — no TypeScript errors
- [ ] Deploy: `npm run deploy`
- [ ] Check pm2 logs: no `risks is not iterable` errors
- [ ] Check pm2 logs: ghost positions show exit_price
- [ ] Check pm2 logs: stale exit only fires for positions < +1%
- [ ] Manual test: ADJUST with small profit → SL above entry (LONG) or below entry (SHORT)
