# Dashboard: Show BNB Balance (Fee Discount Asset) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show BNB balance in the dashboard `/api/status` endpoint so the operator knows how much fee-discount asset is available in the futures account.

**Architecture:** `getBalance()` from Binance already returns all asset balances (USDT, BNB, etc.) as an array. Currently `getPortfolioState()` filters only USDT. Extend it to also extract the BNB balance and expose it through `PortfolioState`. The `/api/status` endpoint (from Issue #2) will include this field.

**Tech Stack:** TypeScript, Binance `USDMClient.getBalance()`, Vitest

**Issue:** #3

---

### Task 1: Extract BNB balance in getPortfolioState

**Files:**
- Modify: `src/risk/manager.ts` (line 23 — `PortfolioState` interface)
- Modify: `src/binance/market-data.ts` (line 175 — `getPortfolioState()`)
- Test: `tests/binance/market-data.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/market-data.test.ts` inside the existing `describe('MarketDataFetcher')` block:

```typescript
it('getPortfolioState includes BNB balance', async () => {
  mockClient.getBalance = vi.fn().mockResolvedValue([
    { asset: 'USDT', balance: '100.00', availableBalance: '80.00' },
    { asset: 'BNB', balance: '0.15', availableBalance: '0.15' },
  ]);
  mockClient.getAccountInformation = vi.fn().mockResolvedValue({
    totalMarginBalance: '100.00',
    totalUnrealizedProfit: '0',
    assets: [],
    positions: [],
  });

  const state = await fetcher.getPortfolioState();

  expect(state.bnbBalance).toBeCloseTo(0.15);
});

it('getPortfolioState returns 0 BNB when not present', async () => {
  mockClient.getAccountInformation = vi.fn().mockResolvedValue({
    totalMarginBalance: '10.00',
    totalUnrealizedProfit: '0',
    assets: [],
    positions: [],
  });

  const state = await fetcher.getPortfolioState();

  expect(state.bnbBalance).toBe(0);
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: FAIL — `bnbBalance` does not exist on `PortfolioState`

**Step 3: Write minimal implementation**

In `src/risk/manager.ts`, add to `PortfolioState` (after `availableUsd`):

```typescript
export interface PortfolioState {
  balanceUsd: number;
  availableUsd: number;
  marginBalanceUsd: number;
  totalUnrealizedPnl: number;
  bnbBalance: number;               // BNB in futures wallet (for fee discount)
  positions: Position[];
  sessionPnl: number;
  drawdownPct: number;
}
```

In `src/binance/market-data.ts`, in `getPortfolioState()` (after the USDT extraction, around line 181):

```typescript
const bnbAsset = balances.find((b: any) => b.asset === 'BNB');
const bnbBalance = bnbAsset ? parseFloat(bnbAsset.balance || '0') : 0;
```

And include it in the return value:

```typescript
return {
  balanceUsd,
  availableUsd,
  marginBalanceUsd,
  totalUnrealizedPnl,
  bnbBalance,
  positions: openPositions,
  sessionPnl: 0,
  drawdownPct: 0,
};
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat: extract BNB balance from Binance futures wallet
```

---

### Task 2: Expose BNB balance in /api/status endpoint

**Files:**
- Modify: `src/webhook/server.ts` (`/api/status` handler from Issue #2)
- Modify: `tests/webhook/server.test.ts`

**Step 1: Write the failing test**

Add to `tests/webhook/server.test.ts`:

```typescript
it('returns BNB balance in /api/status', async () => {
  const mockSignalBuffer = { add: vi.fn() } as any;
  const mockLogger = { logDecision: vi.fn() } as any;
  const mockMarketData = {
    getPortfolioState: vi.fn().mockResolvedValue({
      balanceUsd: 100,
      availableUsd: 80,
      marginBalanceUsd: 100,
      totalUnrealizedPnl: 0,
      bnbBalance: 0.15,
      positions: [],
      sessionPnl: 0,
      drawdownPct: 0,
    }),
  } as any;

  const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, {
    marketData: mockMarketData,
  });

  const res = await request(app).get('/api/status');

  expect(res.status).toBe(200);
  expect(res.body.bnbBalance).toBeCloseTo(0.15);
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: FAIL — `bnbBalance` not in response

**Step 3: Write minimal implementation**

In `src/webhook/server.ts`, in the `/api/status` handler, add `bnbBalance` to the response:

```typescript
app.get('/api/status', async (_req, res) => {
  if (!deps?.marketData) {
    res.status(503).json({ error: 'Market data not available' });
    return;
  }
  try {
    const portfolio = await deps.marketData.getPortfolioState();
    res.json({
      walletBalance: portfolio.balanceUsd,
      availableBalance: portfolio.availableUsd,
      marginBalance: portfolio.marginBalanceUsd,
      totalUnrealizedPnl: portfolio.totalUnrealizedPnl,
      bnbBalance: portfolio.bnbBalance,
      positions: portfolio.positions,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch portfolio' });
  }
});
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(dashboard): expose BNB balance in /api/status endpoint
```

---

### Task 3: Update all PortfolioState mocks in test suite

**Files:**
- Modify: `tests/trading-loop.test.ts`
- Modify: `tests/llm/swarm-agent.test.ts`
- Modify: any other test file constructing `PortfolioState`

**Step 1: Find all PortfolioState mocks**
Run: `grep -rn 'bnbBalance\|getPortfolioState\|balanceUsd.*positions' tests/`

**Step 2: Add `bnbBalance: 0` to each mock**

Example for `tests/trading-loop.test.ts` (line 37):
```typescript
getPortfolioState: vi.fn().mockResolvedValue({
  balanceUsd: 10, availableUsd: 10, marginBalanceUsd: 10,
  totalUnrealizedPnl: 0, bnbBalance: 0,
  positions: [], sessionPnl: 0, drawdownPct: 0,
}),
```

**Step 3: Run full test suite**
Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**
```
test: add bnbBalance to PortfolioState mocks
```
