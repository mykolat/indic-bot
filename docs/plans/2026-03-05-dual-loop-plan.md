# Dual-Loop Architecture + Multi-Agent Swarm — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the single trading loop into a 1-min algorithmic Watchdog (market snapshots, position monitoring) + 10-60 min LLM Brain (full analysis). Fix position context (SL/TP visibility, entry thesis, min hold time). Redesign Swarm with 5 research-backed personas, structured output, weighted judge, and multi-stage debate pipeline.

**Architecture:** Watchdog runs every minute using lightweight API calls (no candles), fetches market data, diffs against last snapshot, writes to DB if changed. Brain is the current TradingLoop refactored to run on a dynamic 10-60 min schedule, reading aggregated watchdog data from DB. Both run in the same process via separate setInterval/setTimeout. Swarm uses Multi-Agent Debate pattern: generate → critique → revise → judge.

**Tech Stack:** TypeScript ESM, PostgreSQL (Supabase), Vitest

---

## Phase 1: Data Layer

### Task 1: DB migration — `market_snapshots` table + `entry_thesis` column

**Files:**
- Supabase migration (via MCP)

**Step 1: Apply migration**

```sql
-- market_snapshots: Watchdog writes here when data changes
CREATE TABLE market_snapshots (
  id bigserial PRIMARY KEY,
  session_id uuid REFERENCES sessions(id),
  pair text NOT NULL,
  mark_price numeric NOT NULL,
  open_interest numeric,
  funding_rate numeric,
  long_short_ratio numeric,
  order_book_bid_pct numeric,
  order_book_ask_pct numeric,
  imbalance_pct numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_market_snapshots_pair_time ON market_snapshots (pair, created_at DESC);

-- Retention: auto-delete snapshots older than 7 days (run via pg_cron or app-level)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('cleanup-snapshots', '0 3 * * *', $$DELETE FROM market_snapshots WHERE created_at < NOW() - INTERVAL '7 days'$$);

-- Entry thesis for position context
ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS entry_thesis text;
```

**Step 2: Verify migration**

Run: `SELECT column_name FROM information_schema.columns WHERE table_name = 'market_snapshots'`
Expected: All columns present

Run: `SELECT column_name FROM information_schema.columns WHERE table_name = 'trade_executions' AND column_name = 'entry_thesis'`
Expected: 1 row

---

### Task 2: Update `OrderResult` to return SL/TP prices

**Files:**
- Modify: `src/binance/orders.ts`
- Test: `tests/binance/orders.test.ts`

**Step 1: Write failing test**

Add to `tests/binance/orders.test.ts`:

```typescript
it('execute returns fillPrice, slPrice, tpPrice on success', async () => {
  const decision = {
    pair: 'BTCUSDT', action: 'LONG' as const, size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test', confidence: 80,
  };

  mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '70000' });
  mockClient.setLeverage.mockResolvedValue({});
  mockClient.submitNewOrder.mockResolvedValue({
    orderId: 123,
    fills: [{ price: '70000', qty: '0.01' }],
  });
  mockClient.submitNewAlgoOrder.mockResolvedValue({});

  const result = await executor.execute(decision, 1000);

  expect(result.success).toBe(true);
  expect(result.fillPrice).toBeCloseTo(70000);
  expect(result.slPrice).toBeCloseTo(70000 * 0.98); // 2% SL
  expect(result.tpPrice).toBeCloseTo(70000 * 1.05); // 5% TP
  expect(result.quantity).toBeGreaterThan(0);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/orders.test.ts -t "returns fillPrice, slPrice, tpPrice"`
Expected: FAIL — `slPrice` and `tpPrice` not in OrderResult

**Step 3: Update OrderResult interface and execute()**

In `src/binance/orders.ts`, update `OrderResult`:

```typescript
export interface OrderResult {
  success: boolean;
  orderId?: number;
  error?: string;
  fillPrice?: number;
  slPrice?: number;
  tpPrice?: number;
  quantity?: number;
}
```

Update the success return on line 98:

```typescript
return { success: true, orderId: order.orderId, fillPrice, slPrice: stopPrice, tpPrice, quantity };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "feat: OrderResult returns slPrice, tpPrice, quantity"
```

---

### Task 3: Pass full execution data to DB insert (including `entry_thesis`)

**Files:**
- Modify: `src/db/types.ts` (add `entry_thesis` to `DbTradeExecution`)
- Modify: `src/db/repository.ts` (add `entry_thesis` to INSERT SQL)
- Modify: `src/trading-loop.ts` (~lines 866-876)

> **Review fix C1:** `entry_thesis` must be added to BOTH the TypeScript interface AND the repository INSERT SQL, not just the call site.

**Step 1: Add `entry_thesis` to `DbTradeExecution` interface**

In `src/db/types.ts`, add to `DbTradeExecution` (after `size_usd`):

```typescript
  entry_thesis?: string;
```

**Step 2: Update `insertTradeExecution` SQL**

In `src/db/repository.ts`, update the function at line 73:

```typescript
export async function insertTradeExecution(e: Omit<DbTradeExecution, 'id' | 'opened_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO trade_executions (decision_id, pair, side, action, entry_price, fill_price, quantity, leverage, sl_price, tp_price, order_id, algo_sl_id, algo_tp_id, size_usd, entry_thesis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [e.decision_id, e.pair, e.side, e.action, e.entry_price, e.fill_price,
     e.quantity, e.leverage, e.sl_price, e.tp_price, e.order_id,
     e.algo_sl_id, e.algo_tp_id, e.size_usd, e.entry_thesis],
  );
  return rows[0].id;
}
```

**Step 3: Update insertTradeExecution call in trading-loop.ts**

Find the `insertTradeExecution` call in the LONG/SHORT execution block (~line 867). Replace:

```typescript
// BEFORE:
insertTradeExecution({
  decision_id: decisionId,
  pair: decision.pair,
  side: decision.action === 'LONG' ? 'BUY' : 'SELL',
  action: decision.action,
  leverage: decision.leverage,
  order_id: result.orderId,
  size_usd: (decision.size_pct / 100) * portfolio.balanceUsd,
}).catch(e => console.error('[DB] execution insert error:', e.message));

// AFTER:
insertTradeExecution({
  decision_id: decisionId,
  pair: decision.pair,
  side: decision.action === 'LONG' ? 'BUY' : 'SELL',
  action: decision.action,
  leverage: decision.leverage,
  order_id: result.orderId,
  size_usd: (decision.size_pct / 100) * portfolio.balanceUsd,
  fill_price: result.fillPrice,
  sl_price: result.slPrice,
  tp_price: result.tpPrice,
  quantity: result.quantity,
  entry_price: result.fillPrice,
  entry_thesis: decision.reasoning,
}).catch(e => console.error('[DB] execution insert error:', e.message));
```

**Step 4: Commit**

```bash
git add src/db/types.ts src/db/repository.ts src/trading-loop.ts
git commit -m "feat: store fill_price, sl/tp prices, entry thesis in trade_executions"
```

---

## Phase 2: Position Context in LLM Prompt

### Task 4: Query open positions' SL/TP + entry thesis from DB

**Files:**
- Modify: `src/db/repository.ts`
- Test: `tests/db/repository.test.ts` (new)

> **Review fix H2:** This query is critical — DISTINCT ON, LEFT JOIN, time filter. Must have a test.

**Step 1: Add query function to repository.ts**

```typescript
export interface OpenPositionContext {
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

export async function getOpenPositionContexts(pairs: string[]): Promise<OpenPositionContext[]> {
  if (pairs.length === 0) return [];
  const placeholders = pairs.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q().query(
    `SELECT DISTINCT ON (te.pair)
            te.pair, te.side, te.fill_price, te.sl_price, te.tp_price,
            te.entry_thesis, te.leverage, te.size_usd, te.opened_at
     FROM trade_executions te
     LEFT JOIN trade_closes tc ON tc.execution_id = te.id
     WHERE te.pair IN (${placeholders})
       AND tc.id IS NULL
       AND te.fill_price IS NOT NULL
       AND te.opened_at > NOW() - INTERVAL '48 hours'
     ORDER BY te.pair, te.opened_at DESC`,
    pairs,
  );
  return rows;
}
```

**Step 2: Write test**

Create `tests/db/repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg pool
const mockQuery = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { getOpenPositionContexts } from '../../src/db/repository.js';

describe('getOpenPositionContexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty pairs', async () => {
    const result = await getOpenPositionContexts([]);
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns position contexts for given pairs', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        pair: 'BTCUSDT',
        side: 'BUY',
        fill_price: 70000,
        sl_price: 68600,
        tp_price: 73500,
        entry_thesis: 'Bullish breakout',
        leverage: 5,
        size_usd: 500,
        opened_at: new Date().toISOString(),
      }],
    });

    const result = await getOpenPositionContexts(['BTCUSDT', 'ETHUSDT']);

    expect(result).toHaveLength(1);
    expect(result[0].pair).toBe('BTCUSDT');
    expect(result[0].sl_price).toBe(68600);
    // Verify SQL contains DISTINCT ON, LEFT JOIN, and 48h filter
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('DISTINCT ON');
    expect(sql).toContain('LEFT JOIN trade_closes');
    expect(sql).toContain('48 hours');
  });

  it('passes pairs as parameterized query', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getOpenPositionContexts(['BTCUSDT', 'ETHUSDT']);

    expect(mockQuery.mock.calls[0][1]).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(mockQuery.mock.calls[0][0]).toContain('$1');
    expect(mockQuery.mock.calls[0][0]).toContain('$2');
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/db/repository.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add src/db/repository.ts tests/db/repository.test.ts
git commit -m "feat: getOpenPositionContexts query with test — SL/TP + entry thesis from DB"
```

---

### Task 5: Show SL/TP + entry thesis in LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts` (EnrichedPromptData + buildEnrichedPrompt)
- Modify: `src/trading-loop.ts` (pass position contexts to promptData)

**Step 1: Update EnrichedPromptData**

Add to `EnrichedPromptData` interface in `src/llm/prompts.ts`:

```typescript
positionContexts?: Array<{
  pair: string;
  sl_price: number;
  tp_price: number;
  entry_thesis: string;
  fill_price: number;
}>;
```

**Step 2: Update buildEnrichedPrompt — portfolio section**

In `buildEnrichedPrompt`, replace the open positions rendering (~lines 477-485):

```typescript
  if (data.portfolio.positions.length > 0) {
    prompt += 'Open positions:\n';
    for (const pos of data.portfolio.positions) {
      const pnlSign = pos.unrealizedPnlPct >= 0 ? '+' : '';
      prompt += `  ${pos.pair} ${pos.side} | entry $${pos.entryPrice.toFixed(2)} | held ${pos.heldHours.toFixed(1)}h | P&L: ${pnlSign}${pos.unrealizedPnlPct.toFixed(1)}% | ${pos.leverage}x leverage\n`;

      // SL/TP context from DB
      const ctx = data.positionContexts?.find(c => c.pair === pos.pair);
      if (ctx) {
        const slDist = ((Math.abs(ctx.fill_price - ctx.sl_price) / ctx.fill_price) * 100).toFixed(1);
        const tpDist = ((Math.abs(ctx.tp_price - ctx.fill_price) / ctx.fill_price) * 100).toFixed(1);
        const slHit = pos.side === 'LONG'
          ? parseFloat(data.snapshots.find(s => s.pair === pos.pair)?.markPrice || '0') <= ctx.sl_price
          : parseFloat(data.snapshots.find(s => s.pair === pos.pair)?.markPrice || '0') >= ctx.sl_price;
        prompt += `    SL: $${ctx.sl_price.toFixed(2)} (${slDist}% away) ${slHit ? 'HIT' : 'NOT hit'} | TP: $${ctx.tp_price.toFixed(2)} (${tpDist}% away)\n`;
        prompt += `    Entry thesis: ${ctx.entry_thesis}\n`;
        prompt += `    >>> DO NOT close this position unless SL is hit or thesis is invalidated <<<\n`;
      }
    }
  } else {
    prompt += 'No open positions.\n';
  }
```

**Step 3: Pass position contexts in trading-loop.ts**

In `src/trading-loop.ts`, before building `promptData` (~line 456), add:

```typescript
// Fetch SL/TP + entry thesis for open positions from DB
// NOTE: add getOpenPositionContexts to the existing static import from './db/repository.js' at line 29
let positionContexts: Array<{ pair: string; sl_price: number; tp_price: number; entry_thesis: string; fill_price: number }> = [];
if (this.deps.sessionId && portfolio.positions.length > 0) {
  try {
    positionContexts = await getOpenPositionContexts(portfolio.positions.map(p => p.pair));
  } catch (e: any) {
    console.error('[Loop] Failed to fetch position contexts:', e.message);
  }
}
```

Add `positionContexts` to the `promptData` object:

```typescript
const promptData = {
  // ... existing fields ...
  positionContexts,
};
```

**Step 4: Commit**

```bash
git add src/llm/prompts.ts src/trading-loop.ts
git commit -m "feat: SL/TP + entry thesis in LLM prompt — prevents premature closes"
```

---

### Task 6: Min hold time — prevent CLOSE within N minutes of OPEN

**Files:**
- Modify: `src/trading-loop.ts`
- Test: `tests/trading-loop.test.ts`

> **Review fix H1:** Must guard against `undefined` heldHours (NaN bypass).

**Step 1: Write failing test**

```typescript
it('blocks LLM CLOSE within min hold time of entry', async () => {
  // Position opened 3 minutes ago
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 1000, sessionPnl: -10, drawdownPct: 1,
    positions: [
      { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -2, heldHours: 0.05 },
    ],
  });
  mockLlm.analyze.mockResolvedValue([
    { pair: 'BTCUSDT', action: 'CLOSE', reasoning: 'panic close', confidence: 90 },
  ]);

  await loop.runOnce();

  // CLOSE should be blocked — position is too young
  expect(mockOrders.close).not.toHaveBeenCalled();
});

it('blocks CLOSE when heldHours is undefined', async () => {
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 1000, sessionPnl: -10, drawdownPct: 1,
    positions: [
      { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -2, heldHours: undefined },
    ],
  });
  mockLlm.analyze.mockResolvedValue([
    { pair: 'BTCUSDT', action: 'CLOSE', reasoning: 'panic close', confidence: 90 },
  ]);

  await loop.runOnce();

  expect(mockOrders.close).not.toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trading-loop.test.ts -t "blocks LLM CLOSE within min hold time"`
Expected: FAIL — currently CLOSE goes through

**Step 3: Implement min hold time with NaN guard**

In `src/trading-loop.ts`, in the CLOSE execution block (~line 793), add before the existing `const pos = portfolio.positions.find(...)`:

```typescript
if (decision.action === 'CLOSE') {
  const pos = portfolio.positions.find((p) => p.pair === decision.pair);
  if (pos) {
    // Min hold time: don't close positions held < 10 minutes
    // NaN guard: undefined * 60 = NaN, NaN < 10 = false — must explicitly check
    const minHoldMinutes = 10;
    const heldMinutes = pos.heldHours ? pos.heldHours * 60 : 0;
    if (heldMinutes < minHoldMinutes) {
      console.log(`[HoldLock] Blocking CLOSE on ${decision.pair} — held ${heldMinutes.toFixed(0)}m < ${minHoldMinutes}m minimum`);
      continue;
    }
    // ... rest of CLOSE logic
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: min hold time (10 min) with NaN guard — prevents panic closes"
```

---

## Phase 3: Watchdog

### Task 7: DB types + repository for market_snapshots

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/repository.ts`

**Step 1: Add DbMarketSnapshot type**

In `src/db/types.ts`:

```typescript
export interface DbMarketSnapshot {
  id?: number;
  session_id?: string;
  pair: string;
  mark_price: number;
  open_interest?: number;
  funding_rate?: number;
  long_short_ratio?: number;
  order_book_bid_pct?: number;
  order_book_ask_pct?: number;
  imbalance_pct?: number;
  created_at?: string;
}
```

**Step 2: Add insert + query functions**

In `src/db/repository.ts`:

```typescript
export async function insertMarketSnapshot(s: Omit<DbMarketSnapshot, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO market_snapshots (session_id, pair, mark_price, open_interest, funding_rate, long_short_ratio, order_book_bid_pct, order_book_ask_pct, imbalance_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [s.session_id, s.pair, s.mark_price, s.open_interest, s.funding_rate,
     s.long_short_ratio, s.order_book_bid_pct, s.order_book_ask_pct, s.imbalance_pct],
  );
  return rows[0].id;
}

export async function getLatestMarketSnapshot(pair: string): Promise<DbMarketSnapshot | null> {
  const { rows } = await q().query(
    `SELECT * FROM market_snapshots WHERE pair = $1 ORDER BY created_at DESC LIMIT 1`,
    [pair],
  );
  return rows[0] || null;
}

export async function getMarketSnapshotsSince(pair: string, sinceMinutes: number): Promise<DbMarketSnapshot[]> {
  const { rows } = await q().query(
    `SELECT * FROM market_snapshots
     WHERE pair = $1 AND created_at > NOW() - INTERVAL '1 minute' * $2
     ORDER BY created_at ASC`,
    [pair, sinceMinutes],
  );
  return rows;
}
```

**Step 3: Commit**

```bash
git add src/db/types.ts src/db/repository.ts
git commit -m "feat: market_snapshots DB types + insert/query functions"
```

---

### Task 8: Lightweight market data fetch for Watchdog

**Files:**
- Modify: `src/binance/market-data.ts`
- Test: `tests/binance/market-data.test.ts` (new)

> **Review fix C3:** `getSnapshot()` does 8 API calls (incl. 3× candles). Watchdog needs only 5 light calls. Avoids 150 candle fetches/minute × 8 pairs = wasted bandwidth + rate limit risk.

**Step 1: Write failing test**

Create `tests/binance/market-data.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MarketDataFetcher } from '../../src/binance/market-data.js';

describe('MarketDataFetcher.getQuickSnapshot', () => {
  it('fetches only price, OI, funding, lsRatio, orderBook — no candles', async () => {
    const mockClient = {
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: '70000' }),
      futuresOpenInterestHistory: vi.fn().mockResolvedValue([{ sumOpenInterest: '50000' }]),
      getFundingRateHistory: vi.fn().mockResolvedValue([{ fundingRate: '0.0001', fundingTime: Date.now() }]),
      getTopLongShortAccountRatio: vi.fn().mockResolvedValue([{ longShortRatio: '1.2' }]),
      getOrderBook: vi.fn().mockResolvedValue({
        bids: [['70000', '10']],
        asks: [['70100', '8']],
      }),
      // These should NOT be called:
      getKlines: vi.fn(),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const snap = await fetcher.getQuickSnapshot('BTCUSDT');

    expect(snap.pair).toBe('BTCUSDT');
    expect(snap.markPrice).toBe('70000');
    expect(snap.openInterest).toBeDefined();
    expect(mockClient.getKlines).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: FAIL — `getQuickSnapshot` not defined

**Step 3: Implement `getQuickSnapshot`**

In `src/binance/market-data.ts`, add new interface and method:

```typescript
export interface QuickSnapshot {
  pair: string;
  markPrice: string;
  openInterest: string;
  fundingRate: string;
  longShortRatio: number | null;
  orderBookBidPct: number;
  orderBookAskPct: number;
  imbalancePct?: number;
}

// In MarketDataFetcher class:
async getQuickSnapshot(pair: string): Promise<QuickSnapshot> {
  const [markPriceData, oiData, fundingData, lsData, orderBook] =
    await Promise.allSettled([
      this.client.getMarkPrice({ symbol: pair }),
      this.client.futuresOpenInterestHistory({ symbol: pair, period: '5m', limit: 1 }),
      this.client.getFundingRateHistory({ symbol: pair, limit: 1 }),
      this.client.getTopLongShortAccountRatio({ symbol: pair, period: '5m', limit: 1 }),
      this.client.getOrderBook({ symbol: pair, limit: 20 }),
    ]);

  const markPrice = markPriceData.status === 'fulfilled'
    ? markPriceData.value.markPrice : '0';
  const oi = oiData.status === 'fulfilled' && oiData.value[0]
    ? oiData.value[0].sumOpenInterest : '0';
  const funding = fundingData.status === 'fulfilled' && fundingData.value[0]
    ? fundingData.value[0].fundingRate : '0';
  const lsRatio = lsData.status === 'fulfilled' && lsData.value[0]
    ? parseFloat(lsData.value[0].longShortRatio) : null;

  let bidPct = 50, askPct = 50;
  let imbalancePct: number | undefined;
  if (orderBook.status === 'fulfilled') {
    const bids = orderBook.value.bids || [];
    const asks = orderBook.value.asks || [];
    const bidVol = bids.reduce((s: number, b: string[]) => s + parseFloat(b[1] || '0'), 0);
    const askVol = asks.reduce((s: number, a: string[]) => s + parseFloat(a[1] || '0'), 0);
    const total = bidVol + askVol;
    if (total > 0) {
      bidPct = Math.round((bidVol / total) * 100);
      askPct = 100 - bidPct;
      imbalancePct = Math.round(((bidVol - askVol) / total) * 100);
    }
  }

  return {
    pair,
    markPrice,
    openInterest: oi,
    fundingRate: funding,
    longShortRatio: lsRatio,
    orderBookBidPct: bidPct,
    orderBookAskPct: askPct,
    imbalancePct,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/binance/market-data.ts tests/binance/market-data.test.ts
git commit -m "feat: getQuickSnapshot — lightweight market data for Watchdog (no candles)"
```

---

### Task 9: Watchdog class

**Files:**
- Create: `src/watchdog.ts`
- Test: `tests/watchdog.test.ts`

**Step 1: Write tests**

Create `tests/watchdog.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Watchdog } from '../src/watchdog.js';

describe('Watchdog', () => {
  let mockMarketData: any;
  let mockInsertSnapshot: any;
  let mockGetLatest: any;

  beforeEach(() => {
    mockMarketData = {
      getQuickSnapshot: vi.fn().mockResolvedValue({
        pair: 'BTCUSDT',
        markPrice: '70000',
        openInterest: '50000',
        fundingRate: '0.0001',
        orderBookBidPct: 55,
        orderBookAskPct: 45,
        longShortRatio: 1.2,
      }),
    };
    mockInsertSnapshot = vi.fn().mockResolvedValue(1);
    mockGetLatest = vi.fn().mockResolvedValue(null);
  });

  it('writes snapshot on first tick (no previous)', async () => {
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });

    await wd.tick();
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips write when nothing changed', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 70000,
      open_interest: 50000,
      funding_rate: 0.0001,
      long_short_ratio: 1.2,
      order_book_bid_pct: 55,
      order_book_ask_pct: 45,
    });

    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });

    await wd.tick();
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it('writes when price changed', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 69500,  // different from 70000
      open_interest: 50000,
      funding_rate: 0.0001,
    });

    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });

    await wd.tick();
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('fires onAnomaly for price spike > 2%', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 68000,  // 2.9% away from 70000
      open_interest: 50000,
      funding_rate: 0.0001,
    });
    const onAnomaly = vi.fn();

    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
      onAnomaly,
    });

    await wd.tick();
    expect(onAnomaly).toHaveBeenCalledWith('BTCUSDT', 'PRICE_SPIKE', expect.stringContaining('%'));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/watchdog.test.ts`
Expected: FAIL — module not found

**Step 3: Implement Watchdog**

Create `src/watchdog.ts`:

```typescript
import type { MarketDataFetcher, QuickSnapshot } from './binance/market-data.js';
import type { DbMarketSnapshot } from './db/types.js';

export interface WatchdogDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  sessionId: string;
  insertSnapshot: (s: Omit<DbMarketSnapshot, 'id' | 'created_at'>) => Promise<number>;
  getLatestSnapshot: (pair: string) => Promise<DbMarketSnapshot | null>;
  onAnomaly?: (pair: string, type: string, detail: string) => void;
}

export class Watchdog {
  private deps: WatchdogDeps;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WatchdogDeps) {
    this.deps = deps;
  }

  start(intervalMs = 60_000): void {
    console.log(`[Watchdog] Starting — ${this.deps.pairs.length} pairs, every ${intervalMs / 1000}s`);
    this.intervalId = setInterval(() => this.tick().catch(e => console.error('[Watchdog] tick error:', e.message)), intervalMs);
    this.tick().catch(e => console.error('[Watchdog] initial tick error:', e.message));
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(): Promise<void> {
    const results = await Promise.allSettled(
      this.deps.pairs.map(pair => this.processPair(pair)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[Watchdog] pair tick failed:', r.reason);
      }
    }
  }

  private async processPair(pair: string): Promise<void> {
    const snap = await this.deps.marketData.getQuickSnapshot(pair);
    const prev = await this.deps.getLatestSnapshot(pair);

    const current = this.extractFields(snap);

    if (prev && !this.hasChanged(prev, current)) {
      return; // No change — skip write
    }

    await this.deps.insertSnapshot({
      session_id: this.deps.sessionId,
      ...current,
    });

    // Anomaly detection
    if (prev && this.deps.onAnomaly) {
      const priceDelta = Math.abs(current.mark_price - Number(prev.mark_price)) / Number(prev.mark_price) * 100;
      if (priceDelta > 2) {
        this.deps.onAnomaly(pair, 'PRICE_SPIKE', `${priceDelta.toFixed(1)}% in 1 min`);
      }
      if (prev.open_interest && current.open_interest) {
        const oiDelta = Math.abs(current.open_interest - Number(prev.open_interest)) / Number(prev.open_interest) * 100;
        if (oiDelta > 10) {
          this.deps.onAnomaly(pair, 'OI_SPIKE', `${oiDelta.toFixed(1)}% change`);
        }
      }
    }
  }

  private extractFields(snap: QuickSnapshot): Omit<DbMarketSnapshot, 'id' | 'created_at' | 'session_id'> {
    return {
      pair: snap.pair,
      mark_price: parseFloat(snap.markPrice),
      open_interest: parseFloat(snap.openInterest),
      funding_rate: parseFloat(snap.fundingRate),
      long_short_ratio: snap.longShortRatio ?? undefined,
      order_book_bid_pct: snap.orderBookBidPct,
      order_book_ask_pct: snap.orderBookAskPct,
      imbalance_pct: snap.imbalancePct,
    };
  }

  private hasChanged(prev: DbMarketSnapshot, current: Omit<DbMarketSnapshot, 'id' | 'created_at' | 'session_id'>): boolean {
    if (Number(prev.mark_price) !== current.mark_price) return true;
    if (Number(prev.open_interest) !== current.open_interest) return true;
    if (Number(prev.funding_rate) !== current.funding_rate) return true;
    if (Number(prev.long_short_ratio) !== current.long_short_ratio) return true;
    if (Number(prev.order_book_bid_pct) !== current.order_book_bid_pct) return true;
    return false;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/watchdog.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/watchdog.ts tests/watchdog.test.ts
git commit -m "feat: Watchdog class — 1-min lightweight market snapshots with diff-only writes"
```

---

### Task 10: Aggregation — build summary from snapshots for Brain

**Files:**
- Create: `src/watchdog-summary.ts`
- Test: `tests/watchdog-summary.test.ts`

**Step 1: Write test**

Create `tests/watchdog-summary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildWatchdogSummary } from '../src/watchdog-summary.js';

describe('buildWatchdogSummary', () => {
  it('summarizes price movement and SL status', () => {
    const snapshots = [
      { mark_price: 70000, open_interest: 50000, created_at: new Date(Date.now() - 600000).toISOString() },
      { mark_price: 70200, open_interest: 50500, created_at: new Date(Date.now() - 300000).toISOString() },
      { mark_price: 70350, open_interest: 51000, created_at: new Date().toISOString() },
    ];
    const positionCtx = { sl_price: 69000, tp_price: 73000, fill_price: 70000, side: 'BUY' };

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, positionCtx as any);

    expect(summary).toContain('BTCUSDT');
    expect(summary).toContain('+0.5%');  // 70000 -> 70350
    expect(summary).toContain('SL NOT hit');
    expect(summary).toContain('OI');
  });

  it('returns minimal summary when no snapshots', () => {
    const summary = buildWatchdogSummary('BTCUSDT', [], undefined);
    expect(summary).toContain('no data');
  });
});
```

**Step 2: Implement**

Create `src/watchdog-summary.ts`:

```typescript
import type { DbMarketSnapshot } from './db/types.js';
import type { OpenPositionContext } from './db/repository.js';

export function buildWatchdogSummary(
  pair: string,
  snapshots: DbMarketSnapshot[],
  posCtx: OpenPositionContext | undefined,
): string {
  if (snapshots.length === 0) return `${pair}: no data since last Brain cycle`;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const priceDelta = ((Number(last.mark_price) - Number(first.mark_price)) / Number(first.mark_price) * 100).toFixed(1);
  const sign = Number(priceDelta) >= 0 ? '+' : '';
  const minutes = Math.round((new Date(last.created_at!).getTime() - new Date(first.created_at!).getTime()) / 60000);

  let summary = `${pair}: ${sign}${priceDelta}% over ${minutes}m (${snapshots.length} snapshots)`;

  // OI trend
  if (first.open_interest && last.open_interest) {
    const oiDelta = ((Number(last.open_interest) - Number(first.open_interest)) / Number(first.open_interest) * 100).toFixed(1);
    summary += ` | OI ${Number(oiDelta) >= 0 ? '+' : ''}${oiDelta}%`;
  }

  // Position SL/TP status
  if (posCtx) {
    const currentPrice = Number(last.mark_price);
    const slHit = posCtx.side === 'BUY'
      ? currentPrice <= posCtx.sl_price
      : currentPrice >= posCtx.sl_price;
    const tpHit = posCtx.side === 'BUY'
      ? currentPrice >= posCtx.tp_price
      : currentPrice <= posCtx.tp_price;

    summary += ` | SL $${posCtx.sl_price} ${slHit ? 'HIT' : 'NOT hit'}`;
    summary += ` | TP $${posCtx.tp_price} ${tpHit ? 'HIT' : 'NOT hit'}`;
  }

  return summary;
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat: buildWatchdogSummary — aggregates snapshots for Brain prompt"
```

---

## Phase 4: Brain Refactor

### Task 11: Inject watchdog summary into Brain prompt

**Files:**
- Modify: `src/llm/prompts.ts` (EnrichedPromptData + buildEnrichedPrompt)
- Modify: `src/trading-loop.ts`

**Step 1: Add watchdogSummary to EnrichedPromptData**

In `src/llm/prompts.ts`, add to `EnrichedPromptData`:

```typescript
watchdogSummary?: string;
```

**Step 2: Render watchdog summary in prompt**

In `buildEnrichedPrompt`, after the portfolio section (~line 485), add:

```typescript
  if (data.watchdogSummary) {
    prompt += '\n## Watchdog Report (since last Brain cycle)\n';
    prompt += data.watchdogSummary + '\n\n';
  }
```

**Step 3: Build watchdog summary in trading-loop.ts**

In `src/trading-loop.ts`, before building `promptData`, add:

```typescript
// Build watchdog summary from recent market snapshots
// NOTE: add getMarketSnapshotsSince to the static import from './db/repository.js' at line 29
// NOTE: add static import: import { buildWatchdogSummary } from './watchdog-summary.js';
let watchdogSummary: string | undefined;
if (this.deps.sessionId && portfolio.positions.length > 0) {
  try {
    const summaries: string[] = [];
    for (const pos of portfolio.positions) {
      const snaps = await getMarketSnapshotsSince(pos.pair, 60); // last 60 min
      const ctx = positionContexts.find(c => c.pair === pos.pair);
      summaries.push(buildWatchdogSummary(pos.pair, snaps, ctx));
    }
    if (summaries.length > 0) {
      watchdogSummary = summaries.join('\n');
    }
  } catch (e: any) {
    console.error('[Loop] Watchdog summary failed:', e.message);
  }
}
```

Add `watchdogSummary` to the `promptData` object.

**Step 4: Commit**

```bash
git add src/llm/prompts.ts src/trading-loop.ts
git commit -m "feat: inject watchdog summary into Brain LLM prompt"
```

---

### Task 12: Brain schedule — min 10 min without positions

**Files:**
- Modify: `src/index.ts` (~lines 259-262)
- Modify: `src/trading-loop.ts`

**Step 1: Update dynamic interval logic**

In `src/index.ts`, replace the interval logic:

```typescript
// BEFORE:
const nextMs = nextCheckMinutes
  ? Math.max(nextCheckMinutes * 60_000, defaultIntervalMs)
  : defaultIntervalMs;

// AFTER:
const minBrainMs = 10 * 60_000; // 10 min minimum for Brain
const hasPositions = loop.hasOpenPositions?.() ?? false;
const effectiveMin = hasPositions ? defaultIntervalMs : minBrainMs;
const nextMs = nextCheckMinutes
  ? Math.max(nextCheckMinutes * 60_000, effectiveMin)
  : effectiveMin;
```

**Step 2: Add hasOpenPositions method to TradingLoop**

In `src/trading-loop.ts`, add a public method:

```typescript
private _lastPositionCount = 0;

// Called at end of runOnce, after portfolio fetch
hasOpenPositions(): boolean {
  return this._lastPositionCount > 0;
}
```

Update `runOnce()` to set `this._lastPositionCount = portfolio.positions.length` after portfolio fetch.

**Step 3: Commit**

```bash
git add src/index.ts src/trading-loop.ts
git commit -m "feat: Brain min 10 min schedule without positions, Watchdog handles monitoring"
```

---

## Phase 5: Integration

### Task 13: Wire Watchdog + Brain in index.ts

**Files:**
- Modify: `src/index.ts`

**Step 1: Import and create Watchdog**

After the TradingLoop creation (~line 234), add:

```typescript
import { Watchdog } from './watchdog.js';
import { insertMarketSnapshot, getLatestMarketSnapshot } from './db/repository.js';

// Start Watchdog (1 min market snapshots)
let watchdog: Watchdog | undefined;
if (sessionId) {
  watchdog = new Watchdog({
    pairs: config.trading.pairs,
    marketData,
    sessionId,
    insertSnapshot: insertMarketSnapshot,
    getLatestSnapshot: getLatestMarketSnapshot,
    onAnomaly: (pair, type, detail) => {
      console.warn(`[Watchdog] ANOMALY on ${pair}: ${type} — ${detail}`);
      logger.logError('WATCHDOG_ANOMALY', `${pair} ${type}: ${detail}`);
    },
  });
  watchdog.start(60_000);
  console.log('[Watchdog] Started — 1 min snapshots, diff-only writes');
}
```

**Step 2: Stop Watchdog on shutdown**

In the SIGTERM handler:

```typescript
process.on('SIGTERM', async () => {
  console.log('[Bot] SIGTERM received — shutting down...');
  watchdog?.stop();
  // ... rest of shutdown
});
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire Watchdog into main — 1-min market snapshots active"
```

---

### Task 14: Update CLAUDE.md with dual-loop architecture

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add Watchdog section**

Add after the Main loop description:

```markdown
**Watchdog** (`src/watchdog.ts` — 1 min, algorithmic):
- Fetches lightweight market data (price, OI, funding, order book) via `getQuickSnapshot()` — no candles
- Diffs against last DB snapshot — writes only when changed
- Anomaly detection: price spike >2%/min, OI spike >10%
- No LLM calls — pure algorithmic monitoring
- Writes to `market_snapshots` table

**Brain** = TradingLoop with min 10 min schedule (no positions) or config default (with positions). Reads watchdog summaries from DB. SL/TP + entry thesis visible in prompt.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Watchdog + Brain dual-loop to CLAUDE.md"
```

---

## Phase 6: Swarm Redesign — Multi-Agent Debate (Phase 1: Generate + Judge)

> Based on Multi-Agent Debate / Society of Experts research. 5 personas with structured output → weighted judge.

### Task 15a: Lightweight system prompt for persona calls

**Files:**
- Modify: `src/llm/prompts.ts`

> **Review fix C2:** Persona calls currently get `buildSystemPrompt()` which includes the standard `{"decisions": [...]}` JSON format. This conflicts with the new structured expert output format. Personas need a separate lighter system prompt.

**Step 1: Create `buildExpertSystemPrompt` function**

In `src/llm/prompts.ts`, add after `buildConsensusPrompt`:

```typescript
const EXPERT_OUTPUT_FORMAT = `
You MUST respond with ONLY this JSON (no markdown, no explanation):
{
  "persona": "<your_persona_name>",
  "pair": "<pair>",
  "position": "LONG" | "SHORT" | "HOLD" | "CLOSE",
  "thesis": "<1-2 sentence core argument>",
  "arguments": ["<argument 1>", "<argument 2>", "<argument 3>"],
  "probability_of_success": <0-100>,
  "key_risks": ["<risk 1>", "<risk 2>"],
  "confidence": <0-100>
}

For multiple pairs, return an array of these objects.
Output ONLY valid JSON. No text before or after.`;

export function buildExpertSystemPrompt(persona: SwarmPersona): string {
  let personaPrefix = '';
  switch (persona) {
    case 'risk_manager':
      personaPrefix = `You are a PARANOID RISK MANAGER analyzing crypto futures positions on a LIVE account with real money.
Your job is to find reasons NOT to trade.
- Analyze liquidation risk, leverage danger, drawdown scenarios
- Check if SL placement is adequate given current volatility
- Evaluate position sizing relative to account and session P&L
- If session has consecutive losses, argue for reduced exposure or HOLD
- You would rather miss 10 winners than take 1 catastrophic loss`;
      break;

    case 'bull_thesis':
      personaPrefix = `You are a BULL THESIS ANALYST analyzing crypto futures on a LIVE account with real money.
You argue the bullish case with conviction backed by evidence.
- Momentum signals, trend strength, volume confirmation
- Positive news catalysts, sentiment shifts
- Technical breakout patterns, support levels holding
- Macro tailwinds (risk-on, DXY weakness, liquidity)
- Be specific: cite exact indicator values and price levels from the data`;
      break;

    case 'bear_thesis':
      personaPrefix = `You are a BEAR THESIS ANALYST analyzing crypto futures on a LIVE account with real money.
You argue the bearish case with conviction backed by evidence.
- Overbought conditions, divergences, exhaustion signals
- Negative news, regulatory risk, contagion
- Technical resistance, failed breakouts, lower highs
- Macro headwinds (risk-off, DXY strength, liquidity drain)
- Be specific: cite exact indicator values and price levels from the data`;
      break;

    case 'market_structure':
      personaPrefix = `You are a MARKET STRUCTURE EXPERT analyzing crypto futures microstructure on a LIVE account with real money.
You analyze the plumbing underneath price.
- Funding rate: positive/negative, extreme? Who pays whom?
- Open interest: rising with price (conviction) or falling (unwinding)?
- Long/short ratio: crowded trade risk?
- Order book imbalance: bid-heavy or ask-heavy?
- Liquidity zones: where are the clusters of stops/liquidations?
- Volume profile: is this move supported by real volume?`;
      break;

    case 'devils_advocate':
      personaPrefix = `You are the DEVIL'S ADVOCATE (Adversarial) analyzing crypto futures on a LIVE account with real money.
Your job is to ATTACK every position — bull AND bear.
- Find blind spots, assumptions, and logical flaws in ALL arguments
- Challenge consensus — if the data looks bullish, find the bear case. If bearish, find the bull case.
- Ask: "What if the opposite happens? What are we missing?"
- Point out: confirmation bias, recency bias, anchoring to entry price
- You are NOT a defender of any position. You are the stress-tester.
- Your goal: force the judge to consider scenarios others ignored`;
      break;

    case 'narrative_expert':
      personaPrefix = `You are the CROWD SENTIMENT EXPERT with live X/Twitter access analyzing crypto futures on a LIVE account with real money.
You analyze social narrative and crowd positioning.
- What is the dominant narrative on crypto Twitter?
- Is the crowd positioned one way? (contrarian signal)
- Any viral threads, influencer calls, or panic?
- Sentiment vs price divergence?`;
      break;
  }

  return `${personaPrefix}\n\n${EXPERT_OUTPUT_FORMAT}`;
}
```

**Step 2: Update SwarmPersona type**

```typescript
// BEFORE:
export type SwarmPersona = 'permabull' | 'permabear' | 'paranoid_risk_manager' | 'narrative_expert';

// AFTER:
export type SwarmPersona =
  | 'risk_manager'
  | 'bull_thesis'
  | 'bear_thesis'
  | 'market_structure'
  | 'devils_advocate'
  | 'narrative_expert';
```

**Step 3: Keep old `buildSwarmPersonaPrompt` for backward compat during transition**

Don't delete `buildSwarmPersonaPrompt` yet — it's still used in existing code. It will be replaced in Task 15b when `SwarmAgent` is updated.

**Step 4: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: buildExpertSystemPrompt — separate lightweight prompt for Swarm personas"
```

---

### Task 15b: SwarmAgent — new personas + structured parsing + weighted judge

**Files:**
- Modify: `src/llm/swarm-agent.ts`
- Test: `tests/llm/swarm-agent.test.ts`

**Step 1: Write tests**

Add to `tests/llm/swarm-agent.test.ts`:

```typescript
describe('SwarmAgent — Multi-Agent Debate', () => {
  const makeStructuredResponse = (persona: string, position: string, prob: number) =>
    JSON.stringify({
      persona,
      pair: 'BTCUSDT',
      position,
      thesis: `${persona} analysis`,
      arguments: ['arg1', 'arg2'],
      probability_of_success: prob,
      key_risks: ['risk1'],
      confidence: 80,
    });

  it('runs 5 base personas + consensus = 6 LLM calls (no Grok)', async () => {
    const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "confidence": 70, "reasoning": "mixed"}], "next_check_minutes": 15}`;

    const llm = {
      call: vi.fn()
        .mockResolvedValueOnce(makeStructuredResponse('risk_manager', 'HOLD', 30))
        .mockResolvedValueOnce(makeStructuredResponse('bull_thesis', 'LONG', 75))
        .mockResolvedValueOnce(makeStructuredResponse('bear_thesis', 'SHORT', 60))
        .mockResolvedValueOnce(makeStructuredResponse('market_structure', 'HOLD', 50))
        .mockResolvedValueOnce(makeStructuredResponse('devils_advocate', 'HOLD', 40))
        .mockResolvedValueOnce(consensusResponse),
      lastNextCheckMinutes: undefined,
    };
    const agent = new SwarmAgent(llm as any);
    await agent.getConsensus(makeMinimalPromptData());

    // 5 personas + 1 judge = 6 calls
    expect(llm.call).toHaveBeenCalledTimes(6);
  });

  it('passes structured expert outputs to judge prompt', async () => {
    const expertOutput = makeStructuredResponse('bull_thesis', 'LONG', 75);
    const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "LONG", "confidence": 70, "reasoning": "bull"}], "next_check_minutes": 15}`;

    const llm = {
      call: vi.fn()
        .mockResolvedValue(expertOutput),
      lastNextCheckMinutes: undefined,
    };
    // Override last call for consensus
    llm.call.mockResolvedValueOnce(expertOutput)
      .mockResolvedValueOnce(expertOutput)
      .mockResolvedValueOnce(expertOutput)
      .mockResolvedValueOnce(expertOutput)
      .mockResolvedValueOnce(expertOutput)
      .mockResolvedValueOnce(consensusResponse);

    const agent = new SwarmAgent(llm as any);
    await agent.getConsensus(makeMinimalPromptData());

    // Judge call (last) should contain expert outputs
    const judgeCall = llm.call.mock.calls[5];
    const judgeSystem = judgeCall[0]; // system prompt
    expect(judgeSystem).toContain('probability_of_success');
    expect(judgeSystem).toContain('BULL_THESIS');
  });

  it('handles malformed expert output gracefully', async () => {
    const goodOutput = makeStructuredResponse('risk_manager', 'HOLD', 50);
    const badOutput = 'this is not json at all';
    const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "confidence": 60, "reasoning": "safe"}], "next_check_minutes": 15}`;

    const llm = {
      call: vi.fn()
        .mockResolvedValueOnce(goodOutput)
        .mockResolvedValueOnce(badOutput)      // bull_thesis fails parse
        .mockResolvedValueOnce(goodOutput)
        .mockResolvedValueOnce(goodOutput)
        .mockResolvedValueOnce(goodOutput)
        .mockResolvedValueOnce(consensusResponse),
      lastNextCheckMinutes: undefined,
    };
    const agent = new SwarmAgent(llm as any);
    const result = await agent.getConsensus(makeMinimalPromptData());

    // Should not throw — judge still runs with available expert outputs
    expect(result).toBeDefined();
  });
});
```

**Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: FAIL — new persona names not recognized

**Step 3: Rewrite SwarmAgent**

Replace `src/llm/swarm-agent.ts`:

```typescript
import type { LLMClient } from './client.js';
import type { TradeDecision } from '../risk/manager.js';
import { buildUserPrompt, type EnrichedPromptData, buildExpertSystemPrompt, type SwarmPersona } from './prompts.js';
import { insertSwarmPersona, insertLlmConversation } from '../db/repository.js';

interface ExpertOutput {
  persona: string;
  pair: string;
  position: string;
  thesis: string;
  arguments: string[];
  probability_of_success: number;
  key_risks: string[];
  confidence: number;
}

function parseExpertOutput(raw: string, persona: string): ExpertOutput | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.thesis && typeof parsed.probability_of_success === 'number') {
      return { ...parsed, persona };
    }
  } catch {
    const match = raw.match(/\{[\s\S]*"thesis"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.thesis) return { ...parsed, persona };
      } catch { /* ignore */ }
    }
  }
  console.warn(`[Swarm] Failed to parse ${persona} structured output, using raw text`);
  return null;
}

function buildJudgePrompt(expertOutputs: (ExpertOutput | null)[], rawTexts: string[], personas: SwarmPersona[]): string {
  const sections: string[] = [];
  for (let i = 0; i < expertOutputs.length; i++) {
    const eo = expertOutputs[i];
    if (eo) {
      sections.push(`## ${eo.persona.toUpperCase()}
Position: ${eo.position}
Thesis: ${eo.thesis}
Arguments: ${eo.arguments.join('; ')}
probability_of_success: ${eo.probability_of_success}%
Key risks: ${eo.key_risks.join('; ')}
Confidence: ${eo.confidence}/100`);
    } else {
      sections.push(`## ${personas[i].toUpperCase()} (parse failed)\n${rawTexts[i]?.slice(0, 500) ?? 'no output'}`);
    }
  }

  return `You are the SWARM CONSENSUS JUDGE managing a LIVE crypto futures account with real money.

Below are structured opinions from expert analysts. Weigh their arguments by probability_of_success and confidence scores.
Higher probability + higher confidence = more weight.
The Devil's Advocate's job is to find flaws — give extra weight to risks they identify.

${sections.join('\n\n')}

Based on these expert opinions, produce the final consensus trading decision.
If experts strongly disagree, lean towards HOLD.
If the Risk Manager flags critical danger AND the Devil's Advocate agrees, lean towards CLOSE or HOLD.

You MUST respond with valid JSON:
{"decisions": [{"pair": "<pair>", "action": "LONG|SHORT|HOLD|CLOSE", "size_pct": <number>, "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "confidence": <0-100>, "reasoning": "<string>"}], "next_check_minutes": <1-30>}`;
}

export class SwarmAgent {
  sessionId: string | undefined;
  cycleId: number | undefined;

  constructor(private llm: LLMClient, private grokLlm?: any) { }

  async getConsensus(data: EnrichedPromptData): Promise<TradeDecision[]> {
    const userPrompt = buildUserPrompt(data);

    console.log('[Swarm] Multi-Agent Debate: RiskMgr, Bull, Bear, MarketStructure, Devil + Judge');

    const personas: SwarmPersona[] = [
      'risk_manager',
      'bull_thesis',
      'bear_thesis',
      'market_structure',
      'devils_advocate',
    ];

    const expertCalls = personas.map(p =>
      this.llm.call(buildExpertSystemPrompt(p), userPrompt),
    );

    if (this.grokLlm) {
      personas.push('narrative_expert');
      expertCalls.push(
        this.grokLlm.call(buildExpertSystemPrompt('narrative_expert'), userPrompt, 'grok-4-1-fast-reasoning'),
      );
    }

    const results = await Promise.allSettled(expertCalls);
    const rawTexts: string[] = [];
    const expertOutputs: (ExpertOutput | null)[] = [];

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        rawTexts.push(res.value);
        expertOutputs.push(parseExpertOutput(res.value, personas[i]));
        // Save persona to DB
        if (this.sessionId) {
          const eo = expertOutputs[expertOutputs.length - 1];
          insertSwarmPersona({
            persona: personas[i],
            model: personas[i] === 'narrative_expert' ? 'grok' : 'codex',
            raw_response: res.value,
            vote: eo?.position,
            confidence: eo?.confidence,
            reasoning: eo?.thesis || res.value.slice(0, 500),
          }).catch(() => {});
        }
      } else {
        console.warn(`[Swarm] Sub-agent ${personas[i]} failed:`, res.reason);
        rawTexts.push('');
        expertOutputs.push(null);
      }
    }

    const validCount = expertOutputs.filter(Boolean).length;
    if (validCount === 0) {
      console.error('[Swarm] All sub-agents failed, aborting consensus.');
      throw new Error('Swarm failure');
    }

    console.log(`[Swarm] ${validCount}/${personas.length} experts responded. Synthesizing consensus...`);
    const judgeSystem = buildJudgePrompt(expertOutputs, rawTexts, personas);

    let rawConsensus: string;
    try {
      rawConsensus = await this.llm.call(judgeSystem, userPrompt);
      if (this.sessionId) {
        insertLlmConversation({
          cycle_id: this.cycleId,
          session_id: this.sessionId,
          layer: 1,
          model: 'codex',
          method: 'swarm_consensus',
          system_prompt: judgeSystem,
          user_prompt: userPrompt,
          raw_response: rawConsensus,
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[Swarm] Consensus LLM call failed:', e);
      return [];
    }

    let jsonStr: string | undefined;
    try {
      JSON.parse(rawConsensus);
      jsonStr = rawConsensus;
    } catch {
      const match = rawConsensus.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\]\s*[\s\S]*\}/);
      if (match) {
        jsonStr = match[0];
      }
    }

    if (!jsonStr || !jsonStr.includes('"decisions"')) {
      console.error('[Swarm] Consensus parser failed to find JSON');
      return [];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      const ncm = parsed.next_check_minutes;
      if (typeof ncm === 'number' && Number.isFinite(ncm) && ncm >= 1 && ncm <= 30) {
        this.llm.lastNextCheckMinutes = ncm;
      }
      return parsed.decisions || [];
    } catch (e) {
      console.error('[Swarm] Consensus JSON invalid', e);
      return [];
    }
  }
}
```

**Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat: SwarmAgent multi-agent debate — 5 personas, structured output, weighted judge"
```

---

### Task 15c: Delete dead code + cleanup

**Files:**
- Delete: `src/risk/devils-advocate.ts`
- Modify: `src/llm/prompts.ts` (remove old `buildSwarmPersonaPrompt`)

**Step 1: Delete unused DevilsAdvocate class**

```bash
git rm src/risk/devils-advocate.ts
```

**Step 2: Remove old `buildSwarmPersonaPrompt`**

In `src/llm/prompts.ts`, delete the old function (the one that uses `permabull`, `permabear`, etc.) and its `case` blocks. Keep only `buildExpertSystemPrompt`.

Also remove `buildSwarmPersonaPrompt` from any exports.

**Step 3: Verify no imports reference deleted code**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove dead DevilsAdvocate + old persona prompts"
```

---

## Phase 7: Swarm Phase 2 — Critique Stage

> After generate, each expert receives ALL other experts' outputs and writes a critique. Judge receives: expert opinions + critiques. Cost: 5 generate + 5 critique + 1 judge = 11 LLM calls.

### Task 16a: Critique prompt builder

**Files:**
- Modify: `src/llm/prompts.ts`

**Step 1: Add `buildCritiquePrompt` function**

In `src/llm/prompts.ts`, add after `buildExpertSystemPrompt`:

```typescript
const CRITIQUE_OUTPUT_FORMAT = `
You MUST respond with ONLY this JSON (no markdown, no explanation):
{
  "persona": "<your_persona_name>",
  "critiques": [
    {
      "target_persona": "<persona you're critiquing>",
      "agrees": true | false,
      "critique": "<specific flaw or agreement point>",
      "counter_argument": "<if disagrees, your counter>"
    }
  ],
  "updated_probability": <0-100>,
  "updated_position": "LONG" | "SHORT" | "HOLD" | "CLOSE",
  "strongest_risk_found": "<the most important risk across all experts>"
}

Output ONLY valid JSON. No text before or after.`;

export function buildCritiquePrompt(
  persona: SwarmPersona,
  expertOutputs: Array<{ persona: string; thesis: string; position: string; probability_of_success: number; arguments: string[]; key_risks: string[] }>,
): string {
  const otherExperts = expertOutputs
    .filter(e => e.persona !== persona)
    .map(e => `## ${e.persona.toUpperCase()}
Position: ${e.position} (${e.probability_of_success}% probability)
Thesis: ${e.thesis}
Arguments: ${e.arguments.join('; ')}
Risks: ${e.key_risks.join('; ')}`)
    .join('\n\n');

  return `You are ${persona.toUpperCase()} reviewing other experts' analyses for a LIVE crypto futures account.

You already gave your opinion. Now critically evaluate the other experts:

${otherExperts}

Your tasks:
1. Find logical flaws, missing data, or biases in each expert's argument
2. Identify the strongest counter-argument to YOUR OWN position
3. Update your probability based on what you learned
4. State whether you changed your mind or held your position

${CRITIQUE_OUTPUT_FORMAT}`;
}
```

**Step 2: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: buildCritiquePrompt — expert critique stage for multi-agent debate"
```

---

### Task 16b: SwarmAgent critique loop

**Files:**
- Modify: `src/llm/swarm-agent.ts`
- Test: `tests/llm/swarm-agent.test.ts`

**Step 1: Add critique interface and parser**

In `src/llm/swarm-agent.ts`, add:

```typescript
interface CritiqueOutput {
  persona: string;
  critiques: Array<{
    target_persona: string;
    agrees: boolean;
    critique: string;
    counter_argument?: string;
  }>;
  updated_probability: number;
  updated_position: string;
  strongest_risk_found: string;
}

function parseCritiqueOutput(raw: string, persona: string): CritiqueOutput | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.critiques && typeof parsed.updated_probability === 'number') {
      return { ...parsed, persona };
    }
  } catch {
    const match = raw.match(/\{[\s\S]*"critiques"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.critiques) return { ...parsed, persona };
      } catch { /* ignore */ }
    }
  }
  console.warn(`[Swarm] Failed to parse ${persona} critique, skipping`);
  return null;
}
```

**Step 2: Add critique stage to getConsensus**

In `SwarmAgent.getConsensus`, after expert outputs are collected and before judge, add:

```typescript
// === CRITIQUE STAGE ===
// Each expert reviews all other experts' outputs
const validExperts = expertOutputs.filter((eo): eo is ExpertOutput => eo !== null);
const critiqueOutputs: (CritiqueOutput | null)[] = [];

if (validExperts.length >= 3) {
  console.log(`[Swarm] Critique stage: ${validExperts.length} experts critiquing each other...`);

  const critiqueCalls = personas
    .filter((_, i) => expertOutputs[i] !== null)
    .map(persona =>
      this.llm.call(
        buildCritiquePrompt(persona, validExperts),
        userPrompt,
      ),
    );

  const critiqueResults = await Promise.allSettled(critiqueCalls);
  const validPersonas = personas.filter((_, i) => expertOutputs[i] !== null);

  for (let i = 0; i < critiqueResults.length; i++) {
    const res = critiqueResults[i];
    if (res.status === 'fulfilled') {
      critiqueOutputs.push(parseCritiqueOutput(res.value, validPersonas[i]));
    } else {
      console.warn(`[Swarm] Critique from ${validPersonas[i]} failed`);
      critiqueOutputs.push(null);
    }
  }
} else {
  console.log('[Swarm] Skipping critique — not enough valid expert outputs');
}
```

**Step 3: Update judge prompt to include critiques**

Update `buildJudgePrompt` to accept optional critiques:

```typescript
function buildJudgePrompt(
  expertOutputs: (ExpertOutput | null)[],
  rawTexts: string[],
  personas: SwarmPersona[],
  critiques?: (CritiqueOutput | null)[],
): string {
  // ... existing expert sections ...

  let critiqueSection = '';
  if (critiques && critiques.some(Boolean)) {
    critiqueSection = '\n\n## CRITIQUE STAGE RESULTS\n\n';
    for (const c of critiques) {
      if (!c) continue;
      critiqueSection += `### ${c.persona.toUpperCase()} Critique\n`;
      critiqueSection += `Updated position: ${c.updated_position} (${c.updated_probability}%)\n`;
      critiqueSection += `Strongest risk: ${c.strongest_risk_found}\n`;
      for (const crit of c.critiques) {
        critiqueSection += `  - ${crit.agrees ? 'AGREES' : 'DISAGREES'} with ${crit.target_persona}: ${crit.critique}\n`;
        if (crit.counter_argument) {
          critiqueSection += `    Counter: ${crit.counter_argument}\n`;
        }
      }
      critiqueSection += '\n';
    }
  }

  return `You are the SWARM CONSENSUS JUDGE managing a LIVE crypto futures account with real money.

Below are structured opinions from expert analysts, followed by their critiques of each other.

${sections.join('\n\n')}
${critiqueSection}
Based on ALL evidence (initial opinions + critiques), produce the final consensus.
Experts who updated their position after critique carry MORE weight — they changed their mind based on evidence.
If the Devil's Advocate found critical risks that others acknowledged, weigh those heavily.

You MUST respond with valid JSON:
{"decisions": [{"pair": "<pair>", "action": "LONG|SHORT|HOLD|CLOSE", "size_pct": <number>, "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "confidence": <0-100>, "reasoning": "<string>"}], "next_check_minutes": <1-30>}`;
}
```

Pass `critiqueOutputs` to `buildJudgePrompt` in the consensus call.

**Step 4: Write test for critique stage**

```typescript
it('runs critique stage when experts succeed (11 calls total)', async () => {
  const expertResponse = makeStructuredResponse('risk_manager', 'HOLD', 50);
  const critiqueResponse = JSON.stringify({
    persona: 'risk_manager',
    critiques: [{ target_persona: 'bull_thesis', agrees: false, critique: 'too optimistic', counter_argument: 'vol is falling' }],
    updated_probability: 45,
    updated_position: 'HOLD',
    strongest_risk_found: 'declining volume',
  });
  const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "confidence": 70, "reasoning": "mixed"}], "next_check_minutes": 15}`;

  const llm = {
    call: vi.fn()
      // 5 expert calls
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      // 5 critique calls
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      // 1 judge call
      .mockResolvedValueOnce(consensusResponse),
    lastNextCheckMinutes: undefined,
  };
  const agent = new SwarmAgent(llm as any);
  const result = await agent.getConsensus(makeMinimalPromptData());

  // 5 experts + 5 critiques + 1 judge = 11 calls
  expect(llm.call).toHaveBeenCalledTimes(11);
  expect(result).toBeDefined();
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts tests/llm/swarm-agent.test.ts
git commit -m "feat: Swarm Phase 2 — critique stage, experts evaluate each other (11 LLM calls)"
```

---

## Phase 8: Swarm Phase 3 — Revise Stage

> After critique, each expert revises their thesis. Judge receives: original → critique → revised. Cost: 5 + 5 + 5 + 1 = 16 LLM calls. Only for high-stakes decisions.

### Task 17a: Revise prompt builder

**Files:**
- Modify: `src/llm/prompts.ts`

**Step 1: Add `buildRevisePrompt` function**

```typescript
const REVISE_OUTPUT_FORMAT = `
You MUST respond with ONLY this JSON (no markdown, no explanation):
{
  "persona": "<your_persona_name>",
  "original_position": "LONG" | "SHORT" | "HOLD" | "CLOSE",
  "revised_position": "LONG" | "SHORT" | "HOLD" | "CLOSE",
  "changed_mind": true | false,
  "revised_thesis": "<updated 1-2 sentence argument>",
  "revised_arguments": ["<arg 1>", "<arg 2>", "<arg 3>"],
  "revised_probability": <0-100>,
  "key_concessions": ["<what you conceded from critiques>"],
  "final_confidence": <0-100>
}

Output ONLY valid JSON. No text before or after.`;

export function buildRevisePrompt(
  persona: SwarmPersona,
  originalOutput: ExpertOutput,
  critiquesOfMe: Array<{ from: string; agrees: boolean; critique: string; counter_argument?: string }>,
): string {
  const critiqueText = critiquesOfMe
    .map(c => `- ${c.from.toUpperCase()} ${c.agrees ? 'AGREES' : 'DISAGREES'}: ${c.critique}${c.counter_argument ? ` | Counter: ${c.counter_argument}` : ''}`)
    .join('\n');

  return `You are ${persona.toUpperCase()} revising your analysis for a LIVE crypto futures account.

Your original analysis:
Position: ${originalOutput.position} (${originalOutput.probability_of_success}% probability)
Thesis: ${originalOutput.thesis}
Arguments: ${originalOutput.arguments.join('; ')}
Key risks: ${originalOutput.key_risks.join('; ')}

Other experts' critiques of YOUR position:
${critiqueText}

Your tasks:
1. Honestly evaluate the critiques — are they valid?
2. If valid, update your thesis and probability
3. If not valid, defend your position with NEW evidence
4. State clearly if you changed your mind

${REVISE_OUTPUT_FORMAT}`;
}
```

**Step 2: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: buildRevisePrompt — expert revision stage for multi-agent debate"
```

---

### Task 17b: SwarmAgent revise loop + activation gate

**Files:**
- Modify: `src/llm/swarm-agent.ts`
- Test: `tests/llm/swarm-agent.test.ts`

> Revise stage is expensive (16 total calls). Activate only for high-stakes: open positions with >3% unrealized P&L OR size > 30% of balance.

**Step 1: Add revise interface and parser**

In `src/llm/swarm-agent.ts`, add:

```typescript
interface ReviseOutput {
  persona: string;
  original_position: string;
  revised_position: string;
  changed_mind: boolean;
  revised_thesis: string;
  revised_arguments: string[];
  revised_probability: number;
  key_concessions: string[];
  final_confidence: number;
}

function parseReviseOutput(raw: string, persona: string): ReviseOutput | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.revised_probability === 'number' && parsed.revised_thesis) {
      return { ...parsed, persona };
    }
  } catch {
    const match = raw.match(/\{[\s\S]*"revised_thesis"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.revised_thesis) return { ...parsed, persona };
      } catch { /* ignore */ }
    }
  }
  console.warn(`[Swarm] Failed to parse ${persona} revision, skipping`);
  return null;
}
```

**Step 2: Add revise stage to getConsensus (after critique, before judge)**

```typescript
// === REVISE STAGE (only for high-stakes) ===
const reviseOutputs: (ReviseOutput | null)[] = [];
const validCritiques = critiqueOutputs.filter((c): c is CritiqueOutput => c !== null);
const isHighStakes = data.portfolio?.positions?.some(
  p => Math.abs(p.unrealizedPnlPct) > 3 || (p.sizeUsd / (data.portfolio?.balanceUsd || 1)) > 0.3,
) ?? false;

if (validCritiques.length >= 3 && isHighStakes) {
  console.log(`[Swarm] Revise stage (high-stakes): experts updating theses...`);

  const reviseCalls = validExperts.map(eo => {
    // Find critiques aimed at this expert
    const critiquesOfMe = validCritiques
      .flatMap(c => c.critiques
        .filter(crit => crit.target_persona === eo.persona)
        .map(crit => ({ from: c.persona, ...crit })),
      );

    return this.llm.call(
      buildRevisePrompt(eo.persona as SwarmPersona, eo, critiquesOfMe),
      userPrompt,
    );
  });

  const reviseResults = await Promise.allSettled(reviseCalls);
  for (let i = 0; i < reviseResults.length; i++) {
    const res = reviseResults[i];
    if (res.status === 'fulfilled') {
      reviseOutputs.push(parseReviseOutput(res.value, validExperts[i].persona));
    } else {
      reviseOutputs.push(null);
    }
  }
} else if (validCritiques.length >= 3) {
  console.log('[Swarm] Skipping revise — not high-stakes');
}
```

**Step 3: Update judge prompt to include revisions**

Extend `buildJudgePrompt` to accept revisions:

```typescript
function buildJudgePrompt(
  expertOutputs: (ExpertOutput | null)[],
  rawTexts: string[],
  personas: SwarmPersona[],
  critiques?: (CritiqueOutput | null)[],
  revisions?: (ReviseOutput | null)[],
): string {
  // ... existing sections + critique sections ...

  let revisionSection = '';
  if (revisions && revisions.some(Boolean)) {
    revisionSection = '\n\n## REVISED POSITIONS (after critique)\n\n';
    for (const r of revisions) {
      if (!r) continue;
      const changed = r.changed_mind ? 'CHANGED MIND' : 'HELD POSITION';
      revisionSection += `### ${r.persona.toUpperCase()} — ${changed}\n`;
      revisionSection += `${r.original_position} → ${r.revised_position} (${r.revised_probability}%, confidence ${r.final_confidence}/100)\n`;
      revisionSection += `Revised thesis: ${r.revised_thesis}\n`;
      if (r.key_concessions.length > 0) {
        revisionSection += `Concessions: ${r.key_concessions.join('; ')}\n`;
      }
      revisionSection += '\n';
    }
  }

  // Include revision section in final prompt
  // ... (add revisionSection after critiqueSection) ...
}
```

**Step 4: Write test for full pipeline (16 calls)**

```typescript
it('runs full pipeline with revise stage for high-stakes (16 calls)', async () => {
  const expertResponse = makeStructuredResponse('risk_manager', 'HOLD', 50);
  const critiqueResponse = JSON.stringify({
    persona: 'risk_manager',
    critiques: [{ target_persona: 'bull_thesis', agrees: false, critique: 'risky' }],
    updated_probability: 45,
    updated_position: 'HOLD',
    strongest_risk_found: 'leverage',
  });
  const reviseResponse = JSON.stringify({
    persona: 'risk_manager',
    original_position: 'HOLD',
    revised_position: 'HOLD',
    changed_mind: false,
    revised_thesis: 'Still too risky',
    revised_arguments: ['leverage high'],
    revised_probability: 42,
    key_concessions: [],
    final_confidence: 85,
  });
  const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "confidence": 75, "reasoning": "consensus"}], "next_check_minutes": 15}`;

  const llm = {
    call: vi.fn()
      // 5 expert + 5 critique + 5 revise + 1 judge = 16
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(reviseResponse)
      .mockResolvedValueOnce(reviseResponse)
      .mockResolvedValueOnce(reviseResponse)
      .mockResolvedValueOnce(reviseResponse)
      .mockResolvedValueOnce(reviseResponse)
      .mockResolvedValueOnce(consensusResponse),
    lastNextCheckMinutes: undefined,
  };

  // High-stakes: position with -5% PnL
  const highStakesData = {
    ...makeMinimalPromptData(),
    portfolio: {
      balanceUsd: 1000,
      positions: [
        { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 400, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -5, heldHours: 1 },
      ],
    },
  };

  const agent = new SwarmAgent(llm as any);
  const result = await agent.getConsensus(highStakesData as any);

  expect(llm.call).toHaveBeenCalledTimes(16);
  expect(result).toBeDefined();
});

it('skips revise stage for non-high-stakes (11 calls)', async () => {
  const expertResponse = makeStructuredResponse('risk_manager', 'HOLD', 50);
  const critiqueResponse = JSON.stringify({
    persona: 'risk_manager',
    critiques: [{ target_persona: 'bull_thesis', agrees: true, critique: 'fine' }],
    updated_probability: 50,
    updated_position: 'HOLD',
    strongest_risk_found: 'none',
  });
  const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "confidence": 70, "reasoning": "ok"}], "next_check_minutes": 15}`;

  const llm = {
    call: vi.fn()
      // 5 expert + 5 critique + 1 judge = 11 (no revise — low stakes)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(expertResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(critiqueResponse)
      .mockResolvedValueOnce(consensusResponse),
    lastNextCheckMinutes: undefined,
  };

  // Low-stakes: small position, small PnL
  const lowStakesData = {
    ...makeMinimalPromptData(),
    portfolio: {
      balanceUsd: 1000,
      positions: [
        { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 100, leverage: 2, entryPrice: 70000, unrealizedPnlPct: -1, heldHours: 1 },
      ],
    },
  };

  const agent = new SwarmAgent(llm as any);
  await agent.getConsensus(lowStakesData as any);

  expect(llm.call).toHaveBeenCalledTimes(11); // no revise
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts tests/llm/swarm-agent.test.ts
git commit -m "feat: Swarm Phase 3 — revise stage for high-stakes decisions (16 LLM calls)"
```

---

## Summary

| Task | What | Files | LLM Calls |
|------|------|-------|-----------|
| 1 | DB migration: market_snapshots + entry_thesis | Supabase | — |
| 2 | OrderResult returns SL/TP prices | orders.ts | — |
| 3 | Full data in trade_executions insert (+ types + repo) | types.ts, repository.ts, trading-loop.ts | — |
| 4 | Query open positions' SL/TP from DB (+ test) | repository.ts, tests | — |
| 5 | SL/TP + entry thesis in LLM prompt | prompts.ts, trading-loop.ts | — |
| 6 | Min hold time (10 min) with NaN guard | trading-loop.ts, tests | — |
| 7 | DB types for market_snapshots | types.ts, repository.ts | — |
| 8 | Lightweight getQuickSnapshot for Watchdog | market-data.ts, tests | — |
| 9 | Watchdog class | watchdog.ts (new), tests | — |
| 10 | Watchdog summary aggregation | watchdog-summary.ts (new), tests | — |
| 11 | Watchdog summary in Brain prompt | prompts.ts, trading-loop.ts | — |
| 12 | Brain min 10 min schedule | index.ts, trading-loop.ts | — |
| 13 | Wire Watchdog in index.ts | index.ts | — |
| 14 | Update CLAUDE.md | CLAUDE.md | — |
| 15a | Lightweight expert system prompt (no decisions format) | prompts.ts | — |
| 15b | SwarmAgent 5 personas + structured output + weighted judge | swarm-agent.ts, tests | 6-7 |
| 15c | Delete dead DevilsAdvocate + old persona prompts | devils-advocate.ts, prompts.ts | — |
| 16a | Critique prompt builder | prompts.ts | — |
| 16b | SwarmAgent critique loop | swarm-agent.ts, tests | +5 = 11-12 |
| 17a | Revise prompt builder | prompts.ts | — |
| 17b | SwarmAgent revise loop (high-stakes gate) | swarm-agent.ts, tests | +5 = 16-17 |

**Dependencies:**
- 1 → 7 → 8 → 9 → 13 (Watchdog pipeline)
- 1 → 3 → 4 → 5 (Position context pipeline)
- Tasks 2, 6, 10-12, 14 independent
- 15a → 15b → 15c (Swarm Phase 1)
- 15b → 16a → 16b (Swarm Phase 2)
- 16b → 17a → 17b (Swarm Phase 3)

**LLM call scaling:**
| Scenario | Calls |
|----------|-------|
| Normal (no swarm) | 1 |
| Swarm Phase 1 (generate + judge) | 6-7 |
| Swarm Phase 2 (+ critique) | 11-12 |
| Swarm Phase 3 (+ revise, high-stakes only) | 16-17 |

**Production-readiness review fixes integrated:**
- **C1:** `entry_thesis` in types.ts + repository.ts INSERT (Task 3)
- **C2:** Separate `buildExpertSystemPrompt` without decisions format (Task 15a)
- **C3:** `getQuickSnapshot()` for Watchdog — no candles (Task 8)
- **H1:** NaN guard in min hold time (Task 6)
- **H2:** Test for `getOpenPositionContexts` SQL (Task 4)
