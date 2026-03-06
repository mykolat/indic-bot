# Dashboard: Show ROI % and Margin per Position — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Calculate and show ROI % (return on margin) and absolute margin (USD locked) for each open position in the dashboard `/api/status` endpoint so the operator can see capital efficiency at a glance.

**Architecture:** The `Position` interface already has `sizeUsd` (notional) and `leverage`, from which `margin = sizeUsd / leverage`. ROI % = `unrealizedPnlPct` (already computed as PnL/margin in `getPortfolioState()`). We also need the absolute unrealized PnL in USD. Add `marginUsd` and `unrealizedPnlUsd` to the `Position` interface and compute them during position mapping. The `/api/status` endpoint exposes these directly.

**Tech Stack:** TypeScript, Vitest

**Issue:** #4

---

### Task 1: Add marginUsd and unrealizedPnlUsd to Position interface

**Files:**
- Modify: `src/risk/manager.ts` (lines 13-21 — `Position` interface)
- Modify: `src/binance/market-data.ts` (lines 185-207 — position mapping in `getPortfolioState()`)
- Test: `tests/binance/market-data.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/market-data.test.ts`:

```typescript
it('getPortfolioState includes marginUsd and unrealizedPnlUsd per position', async () => {
  mockClient.getPositions = vi.fn().mockResolvedValue([
    {
      symbol: 'BTCUSDT',
      positionAmt: '0.01',
      notional: '500',
      leverage: '10',
      entryPrice: '50000',
      unRealizedProfit: '5.00',
      updateTime: String(Date.now() - 3600000),
    },
  ]);
  mockClient.getAccountInformation = vi.fn().mockResolvedValue({
    totalMarginBalance: '100.00',
    totalUnrealizedProfit: '5.00',
    assets: [],
    positions: [],
  });

  const state = await fetcher.getPortfolioState();

  expect(state.positions).toHaveLength(1);
  const pos = state.positions[0];
  expect(pos.marginUsd).toBeCloseTo(50); // 500 notional / 10x leverage
  expect(pos.unrealizedPnlUsd).toBeCloseTo(5.0);
  expect(pos.unrealizedPnlPct).toBeCloseTo(10.0); // 5 / 50 * 100
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: FAIL — `marginUsd` and `unrealizedPnlUsd` do not exist on `Position`

**Step 3: Write minimal implementation**

In `src/risk/manager.ts`, extend the `Position` interface (line 13):

```typescript
export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  unrealizedPnlPct: number;   // signed % of margin (e.g. -2.4 or +8.1)
  unrealizedPnlUsd: number;   // absolute unrealized PnL in USD
  marginUsd: number;           // margin locked = notional / leverage
  heldHours: number;
}
```

In `src/binance/market-data.ts`, inside the position `.map()` in `getPortfolioState()` (around line 198), add the new fields:

```typescript
return {
  pair: p.symbol,
  sizeUsd: notional,
  leverage,
  side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
  entryPrice: parseFloat(p.entryPrice || '0'),
  unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
  unrealizedPnlUsd: parseFloat(unrealizedProfit.toFixed(2)),
  marginUsd: parseFloat(margin.toFixed(2)),
  heldHours: parseFloat(heldHours.toFixed(1)),
};
```

Note: `margin` is already computed on line 189 as `notional / leverage` and `unrealizedProfit` is parsed on line 191. No new computation needed — just surface them.

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat: add marginUsd + unrealizedPnlUsd to Position interface
```

---

### Task 2: Expose ROI and margin in /api/status positions

**Files:**
- Modify: `tests/webhook/server.test.ts`
- No code change needed in `src/webhook/server.ts` — the endpoint already returns `portfolio.positions` which now includes the new fields

**Step 1: Write the failing test**

Add to `tests/webhook/server.test.ts`:

```typescript
it('returns marginUsd and unrealizedPnlUsd per position', async () => {
  const mockSignalBuffer = { add: vi.fn() } as any;
  const mockLogger = { logDecision: vi.fn() } as any;
  const mockMarketData = {
    getPortfolioState: vi.fn().mockResolvedValue({
      balanceUsd: 100,
      availableUsd: 80,
      marginBalanceUsd: 100,
      totalUnrealizedPnl: 5,
      bnbBalance: 0,
      positions: [
        {
          pair: 'BTCUSDT',
          sizeUsd: 500,
          leverage: 10,
          side: 'LONG',
          entryPrice: 50000,
          unrealizedPnlPct: 10,
          unrealizedPnlUsd: 5,
          marginUsd: 50,
          heldHours: 1.5,
        },
      ],
      sessionPnl: 5,
      drawdownPct: 0,
    }),
  } as any;

  const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, {
    marketData: mockMarketData,
  });

  const res = await request(app).get('/api/status');

  expect(res.status).toBe(200);
  const pos = res.body.positions[0];
  expect(pos.marginUsd).toBe(50);
  expect(pos.unrealizedPnlUsd).toBe(5);
  expect(pos.unrealizedPnlPct).toBe(10);
});
```

**Step 2: Run test to verify it passes**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: PASS — since `/api/status` already passes through `portfolio.positions` as-is

**Step 3: Commit**
```
test: verify ROI + margin per position in /api/status
```

---

### Task 3: Show margin per position in LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts` (line 516 — position display in `buildEnrichedPrompt`)
- Test: add assertion in prompt tests

**Step 1: Write the failing test**

```typescript
it('includes margin USD in position display', () => {
  const prompt = buildUserPrompt({
    snapshots: [{
      pair: 'BTCUSDT', candles1h: [], candles4h: [], candles15m: [],
      fundingRate: '0.0001', fundingHistory: [],
      openInterest: '80000', markPrice: '50000',
      longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
    }],
    indicators: new Map(),
    portfolio: {
      balanceUsd: 100,
      availableUsd: 80,
      marginBalanceUsd: 100,
      totalUnrealizedPnl: 5,
      bnbBalance: 0,
      positions: [{
        pair: 'BTCUSDT', sizeUsd: 500, leverage: 10,
        side: 'LONG' as const, entryPrice: 50000,
        unrealizedPnlPct: 10, unrealizedPnlUsd: 5,
        marginUsd: 50, heldHours: 1.5,
      }],
      sessionPnl: 5,
      drawdownPct: 0,
    },
    signals: [],
    news: [],
    fearGreed: { value: 50, label: 'Neutral' },
  });

  expect(prompt).toContain('margin $50.00');
  expect(prompt).toContain('uPnL $5.00');
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL — current prompt format doesn't include margin or absolute PnL

**Step 3: Write minimal implementation**

In `src/llm/prompts.ts`, update the position line in `buildEnrichedPrompt()` (line 516):

```typescript
for (const pos of data.portfolio.positions) {
  const pnlSign = pos.unrealizedPnlPct >= 0 ? '+' : '';
  const uPnlSign = (pos.unrealizedPnlUsd ?? 0) >= 0 ? '+' : '';
  const marginStr = pos.marginUsd !== undefined ? ` | margin $${pos.marginUsd.toFixed(2)}` : '';
  const uPnlStr = pos.unrealizedPnlUsd !== undefined ? ` | uPnL ${uPnlSign}$${pos.unrealizedPnlUsd.toFixed(2)}` : '';
  prompt += `  ${pos.pair} ${pos.side} | entry $${pos.entryPrice.toFixed(2)} | held ${pos.heldHours.toFixed(1)}h | P&L: ${pnlSign}${pos.unrealizedPnlPct.toFixed(1)}%${uPnlStr}${marginStr} | ${pos.leverage}x leverage\n`;
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(prompt): show margin + absolute PnL per position in LLM context
```

---

### Task 4: Update all test mocks with new Position fields

**Files:**
- Modify: `tests/trading-loop.test.ts` (any Position mocks)
- Modify: `tests/llm/swarm-agent.test.ts`
- Modify: any other test file constructing `Position`

**Step 1: Find all Position constructions**
Run: `grep -rn 'unrealizedPnlPct\|sizeUsd.*leverage' tests/`

**Step 2: Add missing fields**

For every Position object in tests, add:
```typescript
unrealizedPnlUsd: 0,
marginUsd: 10,
```

Use values consistent with the existing `sizeUsd` and `leverage` (margin = sizeUsd / leverage).

**Step 3: Run full test suite**
Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**
```
test: update Position mocks with marginUsd + unrealizedPnlUsd
```
