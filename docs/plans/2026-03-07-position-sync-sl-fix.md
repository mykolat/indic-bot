# Position Sync & Smart SL Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three critical bugs: ghost positions (no trade_closes when SL/TP fires on Binance), aggressive SL tightening (kills profits at +0.5%), and add real-time position sync via WebSocket.

**Architecture:**
1. Position reconciliation loop (polling fallback) — each Brain cycle, diff DB open positions vs Binance
2. Binance User Data Stream (WebSocket) — real-time ORDER_TRADE_UPDATE events write trade_closes immediately
3. Smart SL tightening — tiered ADJUST thresholds so SL only tightens meaningfully at significant profit levels

**Tech Stack:** TypeScript ESM, `binance` npm (USDMClient + WebsocketClient), Vitest, pg (Supabase)

---

### Task 1: Position Reconciliation (polling fallback)

**Why:** Even with WebSocket, we need a fallback that catches missed events (reconnect gaps, bot restart). Each Brain cycle should detect ghost positions and close them in DB.

**Files:**
- Create: `src/position-reconciler.ts`
- Modify: `src/trading-loop.ts` (wire reconciler into `runOnce()`)
- Modify: `src/db/repository.ts` (add `getDbOpenPositions()`)
- Test: `tests/position-reconciler.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/position-reconciler.test.ts
import { describe, it, expect } from 'vitest';
import { detectGhostPositions } from '../src/position-reconciler.js';

describe('detectGhostPositions', () => {
  it('returns empty when DB and Binance match', () => {
    const dbOpen = [{ id: 1, pair: 'BTCUSDT', side: 'BUY' }];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'LONG' }];
    expect(detectGhostPositions(dbOpen, binancePositions)).toEqual([]);
  });

  it('detects ghost when DB has position but Binance does not', () => {
    const dbOpen = [
      { id: 1, pair: 'BTCUSDT', side: 'BUY' },
      { id: 2, pair: 'ETHUSDT', side: 'SELL' },
    ];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'LONG' }];
    const ghosts = detectGhostPositions(dbOpen, binancePositions);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].pair).toBe('ETHUSDT');
  });

  it('ignores Binance positions not in DB', () => {
    const dbOpen: any[] = [];
    const binancePositions = [{ pair: 'BTCUSDT', side: 'LONG' }];
    expect(detectGhostPositions(dbOpen, binancePositions)).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/position-reconciler.test.ts`
Expected: FAIL — module not found

**Step 3: Implement position-reconciler.ts**

```typescript
// src/position-reconciler.ts
import type { Position } from './risk/manager.js';

export interface DbOpenPosition {
  id: number;
  pair: string;
  side: string; // 'BUY' | 'SELL'
  fill_price?: string;
  opened_at?: string;
}

/**
 * Compare DB "open" positions (no trade_closes) with actual Binance positions.
 * Returns DB positions that no longer exist on Binance (= ghost positions).
 */
export function detectGhostPositions(
  dbOpen: DbOpenPosition[],
  binancePositions: { pair: string; side: string }[],
): DbOpenPosition[] {
  const binanceSet = new Set(
    binancePositions.map(p => `${p.pair}:${p.side === 'LONG' ? 'BUY' : 'SHORT' === p.side ? 'SELL' : p.side}`),
  );
  // Normalize: Binance uses LONG/SHORT, DB uses BUY/SELL
  const normalizedSet = new Set(
    binancePositions.map(p => {
      const side = p.side === 'LONG' ? 'BUY' : p.side === 'SHORT' ? 'SELL' : p.side;
      return `${p.pair}:${side}`;
    }),
  );
  return dbOpen.filter(d => !normalizedSet.has(`${d.pair}:${d.side}`));
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/position-reconciler.test.ts`
Expected: PASS

**Step 5: Add `getDbOpenPositions()` to repository.ts**

Add to `src/db/repository.ts`:
```typescript
export async function getDbOpenPositions(): Promise<Array<{id: number; pair: string; side: string; fill_price: string; opened_at: string}>> {
  const { rows } = await q().query(`
    SELECT te.id, te.pair, te.side, te.fill_price::text, te.opened_at::text
    FROM trade_executions te
    LEFT JOIN trade_closes tc ON tc.execution_id = te.id
    WHERE tc.id IS NULL
      AND te.fill_price IS NOT NULL
      AND te.opened_at > NOW() - INTERVAL '48 hours'
    ORDER BY te.opened_at DESC
  `);
  return rows;
}
```

**Step 6: Wire into trading-loop.ts `runOnce()`**

After `portfolio = await marketData.getPortfolioState()` (around line 350), add reconciliation:

```typescript
// Reconcile: detect positions closed on Binance (SL/TP) but still "open" in DB
try {
  const dbOpen = await getDbOpenPositions();
  const ghosts = detectGhostPositions(dbOpen, portfolio.positions);
  for (const ghost of ghosts) {
    console.log(`[Reconcile] Ghost position: ${ghost.pair} ${ghost.side} (exec #${ghost.id}) — closed on Binance, recording in DB`);
    insertTradeClose({
      execution_id: ghost.id,
      pair: ghost.pair,
      exit_reason: 'sl_tp_triggered',
      pnl_usd: 0, // Unknown without Binance trade history
      pnl_pct: 0,
    }).catch(() => {});
  }
} catch (err: any) {
  console.error('[Reconcile] Error:', err.message);
}
```

**Step 7: Commit**

```bash
git add src/position-reconciler.ts tests/position-reconciler.test.ts src/db/repository.ts src/trading-loop.ts
git commit -m "feat: position reconciliation — detect ghost positions closed by SL/TP on Binance"
```

---

### Task 2: Binance User Data Stream (WebSocket)

**Why:** Real-time notification when SL/TP fires. No polling delay. Writes trade_closes immediately with exact price and PnL.

**Files:**
- Create: `src/binance/user-stream.ts`
- Modify: `src/index.ts` (start stream on boot)
- Modify: `src/db/repository.ts` (add `findOpenExecutionByPair()`)
- Test: `tests/binance/user-stream.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/binance/user-stream.test.ts
import { describe, it, expect } from 'vitest';
import { parseOrderUpdate, isSlTpFill } from '../src/binance/user-stream.js';

describe('parseOrderUpdate', () => {
  it('extracts fields from ORDER_TRADE_UPDATE', () => {
    const event = {
      e: 'ORDER_TRADE_UPDATE',
      o: {
        s: 'BTCUSDT',
        S: 'SELL',
        o: 'STOP_MARKET',
        X: 'FILLED',
        ap: '65000.5',
        rp: '12.34',
        cp: true, // closePosition
        T: 1709827200000,
      },
    };
    const parsed = parseOrderUpdate(event);
    expect(parsed).toEqual({
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP_MARKET',
      status: 'FILLED',
      avgPrice: 65000.5,
      realizedPnl: 12.34,
      closePosition: true,
      tradeTime: 1709827200000,
    });
  });

  it('identifies SL/TP fills', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'FILLED', closePosition: true })).toBe(true);
    expect(isSlTpFill({ orderType: 'TAKE_PROFIT_MARKET', status: 'FILLED', closePosition: true })).toBe(true);
    expect(isSlTpFill({ orderType: 'MARKET', status: 'FILLED', closePosition: false })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/user-stream.test.ts`

**Step 3: Implement user-stream.ts**

```typescript
// src/binance/user-stream.ts
import { USDMClient } from 'binance';

export interface OrderUpdateParsed {
  symbol: string;
  side: string;
  orderType: string;
  status: string;
  avgPrice: number;
  realizedPnl: number;
  closePosition: boolean;
  tradeTime: number;
}

export function parseOrderUpdate(event: any): OrderUpdateParsed {
  const o = event.o;
  return {
    symbol: o.s,
    side: o.S,
    orderType: o.o,
    status: o.X,
    avgPrice: parseFloat(o.ap),
    realizedPnl: parseFloat(o.rp),
    closePosition: !!o.cp,
    tradeTime: o.T,
  };
}

export function isSlTpFill(parsed: Partial<OrderUpdateParsed>): boolean {
  return (
    (parsed.orderType === 'STOP_MARKET' || parsed.orderType === 'TAKE_PROFIT_MARKET') &&
    parsed.status === 'FILLED' &&
    parsed.closePosition === true
  );
}

/**
 * Start Binance User Data Stream. Listens for ORDER_TRADE_UPDATE events
 * and calls onSlTpFill when a SL/TP order is filled.
 */
export async function startUserStream(
  client: USDMClient,
  onSlTpFill: (update: OrderUpdateParsed) => Promise<void>,
): Promise<{ stop: () => void }> {
  // Get listen key
  const { listenKey } = await client.getFuturesUserDataListenKey();

  // Keep-alive every 30 min
  const keepAlive = setInterval(() => {
    client.keepAliveFuturesUserDataListenKey().catch(err =>
      console.error('[UserStream] Keep-alive failed:', err.message),
    );
  }, 30 * 60 * 1000);

  // Connect WebSocket
  const wsUrl = `wss://fstream.binance.com/ws/${listenKey}`;
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(wsUrl);

  ws.on('message', async (data: any) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.e !== 'ORDER_TRADE_UPDATE') return;

      const parsed = parseOrderUpdate(event);
      if (isSlTpFill(parsed)) {
        console.log(`[UserStream] SL/TP filled: ${parsed.symbol} ${parsed.orderType} @ ${parsed.avgPrice} | PnL $${parsed.realizedPnl.toFixed(4)}`);
        await onSlTpFill(parsed);
      }
    } catch (err: any) {
      console.error('[UserStream] Parse error:', err.message);
    }
  });

  ws.on('error', (err) => console.error('[UserStream] WS error:', err.message));
  ws.on('close', () => {
    console.log('[UserStream] WS closed — will reconnect on next cycle');
    clearInterval(keepAlive);
  });

  console.log('[UserStream] Connected to Binance User Data Stream');

  return {
    stop: () => {
      clearInterval(keepAlive);
      ws.close();
    },
  };
}
```

**Step 4: Add `findOpenExecutionByPair()` to repository.ts**

```typescript
export async function findOpenExecutionByPair(pair: string, side: string): Promise<{id: number; fill_price: string; opened_at: string; leverage: number; size_usd: string} | null> {
  const { rows } = await q().query(`
    SELECT te.id, te.fill_price::text, te.opened_at::text, te.leverage, te.size_usd::text
    FROM trade_executions te
    LEFT JOIN trade_closes tc ON tc.execution_id = te.id
    WHERE tc.id IS NULL AND te.pair = $1 AND te.side = $2
      AND te.fill_price IS NOT NULL
      AND te.opened_at > NOW() - INTERVAL '48 hours'
    ORDER BY te.opened_at DESC LIMIT 1
  `, [pair, side]);
  return rows[0] ?? null;
}
```

**Step 5: Wire into index.ts**

After bot starts, start the user stream with a callback that inserts trade_closes:

```typescript
import { startUserStream } from './binance/user-stream.js';
import { findOpenExecutionByPair, insertTradeClose } from './db/repository.js';

// After client is created:
startUserStream(binanceClient, async (update) => {
  // Map Binance side to DB side: if SELL order filled a LONG, the position was BUY
  const posSide = update.side === 'SELL' ? 'BUY' : 'SELL';
  const exec = await findOpenExecutionByPair(update.symbol, posSide);
  if (!exec) {
    console.log(`[UserStream] No open execution found for ${update.symbol} ${posSide}`);
    return;
  }
  const entryPrice = parseFloat(exec.fill_price);
  const pnlPct = posSide === 'BUY'
    ? ((update.avgPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - update.avgPrice) / entryPrice) * 100;
  const heldMs = update.tradeTime - new Date(exec.opened_at).getTime();

  await insertTradeClose({
    execution_id: exec.id,
    pair: update.symbol,
    exit_price: update.avgPrice,
    exit_reason: update.orderType === 'STOP_MARKET' ? 'sl_triggered' : 'tp_triggered',
    pnl_usd: update.realizedPnl,
    pnl_pct: pnlPct,
    held_hours: heldMs / 3600000,
    holding_time_minutes: heldMs / 60000,
  });
  console.log(`[UserStream] trade_closes inserted for ${update.symbol} exec #${exec.id}`);
}).catch(err => console.error('[UserStream] Failed to start:', err.message));
```

**Step 6: Run tests**

Run: `npx vitest run tests/binance/user-stream.test.ts`

**Step 7: Commit**

```bash
git add src/binance/user-stream.ts tests/binance/user-stream.test.ts src/db/repository.ts src/index.ts
git commit -m "feat: Binance WebSocket User Data Stream — real-time SL/TP close detection"
```

---

### Task 3: Smart SL Tightening — Tiered ADJUST Thresholds

**Why:** Current behavior: LLM tightens SL to +0.5% from entry when position is +2% → any small bounce triggers SL → kills profit. Today's 5 trades made $1.38 instead of ~$3.86.

**New rules:** SL ADJUST is tiered based on current profit level. LLM can only tighten SL when profit is significant enough, and SL must stay far enough from current price to survive normal volatility.

**Files:**
- Create: `src/risk/sl-tightening-rules.ts`
- Modify: `src/risk/manager.ts` (add tier validation to ADJUST)
- Modify: `src/llm/prompts.ts` (tell LLM the rules)
- Test: `tests/risk/sl-tightening.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/risk/sl-tightening.test.ts
import { describe, it, expect } from 'vitest';
import { computeAllowedSlRange } from '../src/risk/sl-tightening-rules.js';

describe('computeAllowedSlRange', () => {
  // SHORT position, entry 100, current price 95 (profit = 5%)
  it('at +5% profit, allows SL at breakeven (entry) but not tighter', () => {
    const range = computeAllowedSlRange({
      side: 'SHORT',
      entryPrice: 100,
      currentPrice: 95,
      atrPct: 1.5,
    });
    // At +5% profit, SL can move to entry (breakeven) but not below entry
    expect(range.minSlDistancePct).toBeGreaterThanOrEqual(0);
    expect(range.maxSlPrice).toBeCloseTo(100, 0); // At or near entry
  });

  it('at +20% profit, allows SL at +12% (lock significant profit)', () => {
    const range = computeAllowedSlRange({
      side: 'SHORT',
      entryPrice: 100,
      currentPrice: 80,
      atrPct: 1.5,
    });
    // SL should lock at least some profit but not too tight
    // For SHORT at entry 100: SL at 88 = +12% locked
    expect(range.maxSlPrice).toBeLessThan(100); // Below entry (in profit zone)
    expect(range.maxSlPrice).toBeGreaterThan(80); // Above current price
  });

  it('at +2% profit, SL stays at original level (no tightening allowed)', () => {
    const range = computeAllowedSlRange({
      side: 'SHORT',
      entryPrice: 100,
      currentPrice: 98,
      atrPct: 1.5,
    });
    // Profit too small to warrant tightening — keep SL at entry or above
    expect(range.maxSlPrice).toBeGreaterThanOrEqual(100);
  });

  it('uses ATR for minimum distance from current price', () => {
    const range = computeAllowedSlRange({
      side: 'LONG',
      entryPrice: 100,
      currentPrice: 120,
      atrPct: 2.0,
    });
    // SL must be at least 1.5x ATR away from current price
    const minDistance = 120 * (2.0 * 1.5) / 100;
    expect(120 - range.maxSlPrice).toBeGreaterThanOrEqual(minDistance - 0.01);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/sl-tightening.test.ts`

**Step 3: Implement sl-tightening-rules.ts**

```typescript
// src/risk/sl-tightening-rules.ts

export interface SlRangeInput {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  atrPct: number; // ATR as % of price (e.g. 1.5 = 1.5%)
}

export interface SlRange {
  maxSlPrice: number;          // Tightest allowed SL price
  minSlDistancePct: number;    // Min distance from current price as %
  tier: string;                // Description of current tier
}

/**
 * Tiered SL tightening rules.
 *
 * Profit tiers (unrealized PnL %):
 * - <5%:     No tightening allowed. Keep original SL.
 * - 5-10%:   Move SL to breakeven (entry price).
 * - 10-20%:  Lock 40% of profit. SL = entry + 40% of (current - entry).
 * - 20%+:    Lock 60% of profit. SL = entry + 60% of (current - entry).
 *
 * Additionally: SL must be >= 1.5x ATR away from current price
 * to survive normal volatility.
 */
export function computeAllowedSlRange(input: SlRangeInput): SlRange {
  const { side, entryPrice, currentPrice, atrPct } = input;

  const profitPct = side === 'LONG'
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;

  const atrDistance = currentPrice * (atrPct * 1.5) / 100;

  let lockRatio: number;
  let tier: string;

  if (profitPct < 5) {
    // No tightening — return original SL zone (at or beyond entry)
    tier = 'no_tightening (<5% profit)';
    if (side === 'LONG') {
      return { maxSlPrice: entryPrice, minSlDistancePct: atrPct * 1.5, tier };
    } else {
      return { maxSlPrice: entryPrice, minSlDistancePct: atrPct * 1.5, tier };
    }
  } else if (profitPct < 10) {
    lockRatio = 0;
    tier = 'breakeven (5-10% profit)';
  } else if (profitPct < 20) {
    lockRatio = 0.4;
    tier = 'lock_40pct (10-20% profit)';
  } else {
    lockRatio = 0.6;
    tier = 'lock_60pct (20%+ profit)';
  }

  // Calculate SL price that locks `lockRatio` of profit
  let slFromProfit: number;
  if (side === 'LONG') {
    const profitPerUnit = currentPrice - entryPrice;
    slFromProfit = entryPrice + profitPerUnit * lockRatio;
  } else {
    const profitPerUnit = entryPrice - currentPrice;
    slFromProfit = entryPrice - profitPerUnit * lockRatio;
  }

  // Enforce minimum ATR distance from current price
  let slFromAtr: number;
  if (side === 'LONG') {
    slFromAtr = currentPrice - atrDistance;
  } else {
    slFromAtr = currentPrice + atrDistance;
  }

  // Take the more conservative (further from current price) SL
  let maxSlPrice: number;
  if (side === 'LONG') {
    maxSlPrice = Math.min(slFromProfit, slFromAtr);
  } else {
    maxSlPrice = Math.max(slFromProfit, slFromAtr);
  }

  return {
    maxSlPrice,
    minSlDistancePct: atrPct * 1.5,
    tier,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/risk/sl-tightening.test.ts`

**Step 5: Wire into RiskManager ADJUST validation**

In `src/risk/manager.ts`, in the ADJUST block (after ratchet check, around line 121), add tier validation:

```typescript
import { computeAllowedSlRange } from './sl-tightening-rules.js';

// Inside validate(), ADJUST block, after ratchet check:
if (ctx?.indicators4h) {
  const ind = ctx.indicators4h.get(decision.pair);
  const atrPct = (ind as any)?.atrPct ?? 1.5; // fallback
  const currentPrice = adjustCtx.currentSlPrice; // approximate via last known
  // If we have current price from portfolio:
  const pos = portfolio.positions.find(p => p.pair === decision.pair);
  if (pos) {
    const range = computeAllowedSlRange({
      side: adjustCtx.side,
      entryPrice: adjustCtx.entryPrice,
      currentPrice: pos.entryPrice * (1 + pos.unrealizedPnlPct / 100), // approximate mark
      atrPct,
    });

    if (adjustCtx.side === 'LONG' && newSlPrice > range.maxSlPrice) {
      return { approved: false, reason: `SL too tight: ${range.tier}. Max SL $${range.maxSlPrice.toFixed(4)} (requested $${newSlPrice.toFixed(4)})` };
    }
    if (adjustCtx.side === 'SHORT' && newSlPrice < range.maxSlPrice) {
      return { approved: false, reason: `SL too tight: ${range.tier}. Max SL $${range.maxSlPrice.toFixed(4)} (requested $${newSlPrice.toFixed(4)})` };
    }
  }
}
```

**Step 6: Update LLM prompt with SL rules**

In `src/llm/prompts.ts`, in the system prompt section about ADJUST, add:

```
SL ADJUST RULES (hard-enforced, do not violate):
- <5% unrealized profit: DO NOT tighten SL. Keep original.
- 5-10% profit: Move SL to breakeven (entry price) maximum.
- 10-20% profit: Lock up to 40% of profit (SL = entry + 40% of gain).
- 20%+ profit: Lock up to 60% of profit (SL = entry + 60% of gain).
- SL must ALWAYS be at least 1.5x ATR away from current price.
- Premature tightening kills winners. Let positions breathe.
```

**Step 7: Run full test suite and commit**

Run: `npx vitest run tests/risk/`
Expected: All pass

```bash
git add src/risk/sl-tightening-rules.ts tests/risk/sl-tightening.test.ts src/risk/manager.ts src/llm/prompts.ts
git commit -m "feat: smart SL tightening — tiered thresholds prevent premature profit-killing"
```

---

### Task 4: Keep sync script as operational tool

**Why:** The `scripts/sync-ghost-positions.ts` script is useful for manual reconciliation when bot was down or after deploys.

**Files:**
- Modify: `package.json` (add npm script)

**Step 1: Add npm script**

```json
"sync:positions": "tsx scripts/sync-ghost-positions.ts"
```

**Step 2: Commit**

```bash
git add package.json scripts/sync-ghost-positions.ts
git commit -m "chore: add sync:positions script for manual ghost position reconciliation"
```

---

## Summary

| Bug | Fix | Safety |
|-----|-----|--------|
| Ghost positions (SL/TP fires, no trade_closes) | Task 1: polling reconciliation + Task 2: WebSocket real-time | Polling = fallback, WS = primary |
| Aggressive SL tightening (+0.5% → SL hit) | Task 3: tiered thresholds (no tighten <5%, ATR distance) | Hard-enforced in RiskManager |
| Manual sync tool | Task 4: npm script for ops | Run on VM only |

**Execution order:** Task 1 → Task 2 → Task 3 → Task 4 (sequential — each builds on previous)
