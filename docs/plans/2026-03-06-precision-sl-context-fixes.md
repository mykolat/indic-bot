# Precision + SL Crash + LLM Context Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 production bugs blocking trade execution and add recent decisions context to LLM prompt.

**Architecture:** Task 1 replaces hardcoded quantity rounding with Binance exchangeInfo stepSize lookup. Task 2 adds safe Number coercion for DB values in prompt builder. Task 3 adds a `getRecentDecisions()` DB query and injects last 3 decisions into the LLM prompt.

**Tech Stack:** TypeScript ESM, binance npm (USDMClient), Supabase PostgreSQL, Vitest

---

### Task 1: Fix quantity precision rounding via exchangeInfo

**Files:**
- Modify: `src/binance/orders.ts:13-14` (constructor), `src/binance/orders.ts:139-142` (roundQuantity)
- Test: `tests/binance/orders.test.ts`

**Step 1: Write the failing test for dynamic stepSize rounding**

Add to `tests/binance/orders.test.ts` after the last test:

```typescript
it('rounds quantity to pair stepSize (ADA stepSize=1 → integer)', async () => {
  mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '0.27' });
  mockClient.submitNewOrder.mockResolvedValue({ orderId: 999, fills: [{ price: '0.27', qty: '155' }] });
  mockClient.submitNewAlgoOrder.mockResolvedValue({});

  const executor2 = new OrderExecutor(mockClient, new Map([['ADAUSDT', 0]]));
  const decision: TradeDecision = {
    pair: 'ADAUSDT', action: 'SHORT', size_pct: 12,
    leverage: 5, stop_loss_pct: 2.2, take_profit_pct: 5.8, reasoning: 'test',
  };

  const result = await executor2.execute(decision, 178);
  const qty = parseFloat(mockClient.submitNewOrder.mock.calls[0][0].quantity);
  expect(qty).toBe(Math.floor(qty)); // must be integer for ADA
  expect(result.success).toBe(true);
});

it('rounds quantity with 3 decimals for BTC (stepSize=0.001)', async () => {
  const executor2 = new OrderExecutor(mockClient, new Map([['BTCUSDT', 3]]));
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
  };

  const result = await executor2.execute(decision, 100);
  const qty = parseFloat(mockClient.submitNewOrder.mock.calls[0][0].quantity);
  const decimalPlaces = (qty.toString().split('.')[1] || '').length;
  expect(decimalPlaces).toBeLessThanOrEqual(3);
  expect(result.success).toBe(true);
});

it('falls back to hardcoded precision if stepSize map empty', async () => {
  const executor2 = new OrderExecutor(mockClient);
  const decision: TradeDecision = {
    pair: 'SOLUSDT', action: 'LONG', size_pct: 20,
    leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
  };

  const result = await executor2.execute(decision, 100);
  expect(result.success).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: FAIL — `OrderExecutor` constructor doesn't accept second argument

**Step 3: Implement stepSize support in OrderExecutor**

Modify `src/binance/orders.ts`:

1. Change constructor to accept optional `stepSizeDecimals` map:
```typescript
export class OrderExecutor {
  private stepDecimals: Map<string, number>;

  constructor(private client: any, stepDecimals?: Map<string, number>) {
    this.stepDecimals = stepDecimals ?? new Map();
  }
```

2. Replace `roundQuantity`:
```typescript
private roundQuantity(qty: number, pair: string): number {
  const decimals = this.stepDecimals.get(pair)
    ?? (pair.includes('BTC') ? 3 : pair.includes('ETH') ? 2 : 1);
  return Math.floor(qty * 10 ** decimals) / 10 ** decimals;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: ALL PASS

**Step 5: Add stepSize loader in index.ts**

Modify `src/index.ts` — after Binance client init, before OrderExecutor:

```typescript
// Load exchange info for quantity precision
let stepDecimals = new Map<string, number>();
try {
  const info = await binanceClient.getExchangeInfo();
  for (const sym of info.symbols) {
    if (config.trading.pairs.includes(sym.symbol)) {
      const lotFilter = sym.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      if (lotFilter?.stepSize) {
        const step = parseFloat(lotFilter.stepSize);
        const dec = step >= 1 ? 0 : Math.round(-Math.log10(step));
        stepDecimals.set(sym.symbol, dec);
      }
    }
  }
  console.log(`[Binance] Loaded stepSize for ${stepDecimals.size} pairs`);
} catch (e: any) {
  console.warn(`[Binance] Failed to load exchangeInfo: ${e.message} — using defaults`);
}
```

Then pass to OrderExecutor:
```typescript
const orderExecutor = new OrderExecutor(binanceClient, stepDecimals);
```

**Step 6: Run all tests**

Run: `npx vitest run tests/binance/`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/binance/orders.ts src/index.ts tests/binance/orders.test.ts
git commit -m "fix: use exchangeInfo stepSize for quantity rounding (fixes ADA precision)"
```

---

### Task 2: Fix sl_price.toFixed crash in prompts.ts

**Files:**
- Modify: `src/llm/prompts.ts:496-504`
- Test: `tests/llm/prompts.test.ts`

**Step 1: Write the failing test**

Add to `tests/llm/prompts.test.ts`:

```typescript
it('handles string sl_price/tp_price from DB without crashing', () => {
  const data: EnrichedPromptData = {
    snapshots: [{ pair: 'ADAUSDT', markPrice: '0.27', volume24h: 1000, priceChangePercent: -2 }],
    indicators: new Map(),
    portfolio: {
      balanceUsd: 178, availableUsd: 150, sessionPnl: -6,
      positions: [{ pair: 'ADAUSDT', side: 'SHORT', entryPrice: 0.2684, heldHours: 0.8, unrealizedPnlPct: 2.0, leverage: 5 }],
    },
    signals: [], news: [],
    fearGreed: { value: 18, label: 'Extreme Fear' },
    positionContexts: [{
      pair: 'ADAUSDT',
      sl_price: '0.2743' as any,  // string from DB
      tp_price: '0.2528' as any,  // string from DB
      fill_price: '0.2684' as any,
      entry_thesis: 'ADA bearish alignment',
    }],
  };

  const prompt = buildUserPrompt(data);
  expect(prompt).toContain('ADAUSDT');
  expect(prompt).toContain('SL:');
  expect(prompt).not.toContain('undefined');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL with `ctx.sl_price.toFixed is not a function`

**Step 3: Fix with safe Number coercion**

Modify `src/llm/prompts.ts:496-504`:

```typescript
const ctx = data.positionContexts?.find(c => c.pair === pos.pair);
if (ctx) {
  const slPrice = Number(ctx.sl_price);
  const tpPrice = Number(ctx.tp_price);
  const fillPrice = Number(ctx.fill_price);
  if (fillPrice > 0) {
    const slDist = ((Math.abs(fillPrice - slPrice) / fillPrice) * 100).toFixed(1);
    const tpDist = ((Math.abs(tpPrice - fillPrice) / fillPrice) * 100).toFixed(1);
    const slHit = pos.side === 'LONG'
      ? parseFloat(data.snapshots.find(s => s.pair === pos.pair)?.markPrice || '0') <= slPrice
      : parseFloat(data.snapshots.find(s => s.pair === pos.pair)?.markPrice || '0') >= slPrice;
    prompt += `    SL: $${slPrice.toFixed(2)} (${slDist}% away) ${slHit ? 'HIT' : 'NOT hit'} | TP: $${tpPrice.toFixed(2)} (${tpDist}% away)\n`;
    prompt += `    Entry thesis: ${ctx.entry_thesis}\n`;
    prompt += `    >>> DO NOT close this position unless SL is hit or thesis is invalidated <<<\n`;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/prompts.ts tests/llm/prompts.test.ts
git commit -m "fix: safe Number coercion for sl_price/tp_price from DB (fixes toFixed crash)"
```

---

### Task 3: Add recent decisions context to LLM prompt

**Files:**
- Modify: `src/db/repository.ts` (new query)
- Modify: `src/llm/prompts.ts` (EnrichedPromptData + prompt section)
- Modify: `src/trading-loop.ts` (pass recent decisions to prompt data)
- Test: `tests/llm/prompts.test.ts`

**Step 1: Add `getRecentDecisions` to repository**

Add to `src/db/repository.ts`:

```typescript
export interface RecentDecision {
  pair: string;
  action: string;
  confidence: number;
  reasoning: string;
  regime: string;
  created_at: string;
  execution_result?: string; // 'filled' | 'ORDER_FAIL: ...' | null
}

export async function getRecentDecisions(limit: number = 3): Promise<RecentDecision[]> {
  const { rows } = await q().query(
    `SELECT td.pair, td.action, td.confidence, td.reasoning, td.regime, td.created_at,
            CASE
              WHEN te.id IS NOT NULL THEN 'filled'
              WHEN e.message IS NOT NULL THEN 'ORDER_FAIL: ' || e.message
              ELSE NULL
            END as execution_result
     FROM trade_decisions td
     LEFT JOIN trade_executions te ON te.decision_id = td.id
     LEFT JOIN errors e ON e.cycle_id = td.cycle_id AND e.code = 'ORDER_FAIL'
     ORDER BY td.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
```

**Step 2: Add `recentDecisions` to EnrichedPromptData**

Modify `src/llm/prompts.ts` interface:

```typescript
export interface EnrichedPromptData {
  // ... existing fields ...
  recentDecisions?: Array<{
    pair: string;
    action: string;
    confidence: number;
    reasoning: string;
    execution_result?: string;
    created_at: string;
  }>;
}
```

**Step 3: Add prompt section in buildEnrichedPrompt**

Add after the `lastOrderResult` section (around line 210), before market data:

```typescript
if (data.recentDecisions?.length) {
  prompt += '## Recent Decisions (your last actions)\n';
  for (const d of data.recentDecisions) {
    const ago = Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000);
    const result = d.execution_result || 'not executed';
    prompt += `  ${ago}m ago: ${d.pair} ${d.action} (conf ${d.confidence}) → ${result}\n`;
    prompt += `    Reason: ${d.reasoning.slice(0, 150)}\n`;
  }
  prompt += '\n';
}
```

**Step 4: Wire in trading-loop.ts**

In `src/trading-loop.ts`, import `getRecentDecisions` and pass to prompt data.

After position contexts fetch (around line 440), add:

```typescript
let recentDecisions: import('./db/repository.js').RecentDecision[] = [];
try {
  recentDecisions = await getRecentDecisions(3);
} catch { /* DB optional */ }
```

Then in the prompt data object (where `positionContexts` is set), add:

```typescript
recentDecisions,
```

**Step 5: Write test**

Add to `tests/llm/prompts.test.ts`:

```typescript
it('includes recent decisions in prompt', () => {
  const data: EnrichedPromptData = {
    snapshots: [],
    indicators: new Map(),
    portfolio: { balanceUsd: 178, availableUsd: 178, sessionPnl: -6, positions: [] },
    signals: [], news: [],
    fearGreed: { value: 18, label: 'Extreme Fear' },
    recentDecisions: [{
      pair: 'ADAUSDT', action: 'SHORT', confidence: 58,
      reasoning: 'ADA bearish alignment on 1h and 4h',
      execution_result: 'ORDER_FAIL: Precision is over the maximum',
      created_at: new Date(Date.now() - 600000).toISOString(),
    }],
  };

  const prompt = buildUserPrompt(data);
  expect(prompt).toContain('Recent Decisions');
  expect(prompt).toContain('ADAUSDT SHORT');
  expect(prompt).toContain('ORDER_FAIL');
});
```

**Step 6: Run all tests**

Run: `npx vitest run tests/llm/prompts.test.ts tests/binance/`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/db/repository.ts src/llm/prompts.ts src/trading-loop.ts tests/llm/prompts.test.ts
git commit -m "feat: add recent decisions context to LLM prompt from DB"
```

---

### Task 4: Deploy and verify

**Step 1: Run full test suite**

Run: `npm run test`
Expected: ALL PASS

**Step 2: Deploy**

Run: `npm run deploy`

**Step 3: Verify after 2 minutes**

```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 "pm2 logs indic-bot --lines 20 --nostream" 2>&1
```

Check for:
- `[Binance] Loaded stepSize for N pairs` — Task 1 works
- No `sl_price.toFixed` errors — Task 2 works
- No `Precision is over the maximum` errors — Task 1 works
- Swarm parse succeeds (from earlier fix) — watch for `Stage 1: N/N experts responded`

**Step 4: Check DB for new trade decisions**

```sql
SELECT * FROM trade_decisions ORDER BY created_at DESC LIMIT 5;
SELECT * FROM trade_executions ORDER BY opened_at DESC LIMIT 5;
```

**Step 5: Commit deploy verification**

```bash
git add -A
git commit -m "docs: add implementation plan for precision + sl + context fixes"
```
