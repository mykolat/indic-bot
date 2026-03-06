# Clarify Session PnL vs Binance Today's Realized PnL — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make PnL display clearer in dashboard and LLM prompt by distinguishing Session PnL (bot lifetime), Today's Realized PnL (Binance), and Unrealized PnL across open positions.

**Architecture:** Session PnL is `currentBalance - startBalance` (computed in `TradingLoop.runOnce()` at line 200). This is a bot-session metric, not a daily metric. We add `todayRealizedPnl` from Binance's `getIncomeHistory` (type=REALIZED_PNL, filtered to UTC today). All three PnL values are surfaced in the `/api/status` endpoint and the LLM prompt, with clear labels to avoid confusion.

**Tech Stack:** TypeScript, Binance `USDMClient.getIncome()`, Express, Vitest

**Issue:** #5

---

### Task 1: Fetch today's realized PnL from Binance

**Files:**
- Modify: `src/binance/market-data.ts` (add `getTodayRealizedPnl()` method)
- Test: `tests/binance/market-data.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/market-data.test.ts`:

```typescript
describe('MarketDataFetcher.getTodayRealizedPnl', () => {
  it('sums REALIZED_PNL income for today (UTC)', async () => {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const mockClient = {
      getIncome: vi.fn().mockResolvedValue([
        { incomeType: 'REALIZED_PNL', income: '5.20', time: todayStart.getTime() + 3600000, symbol: 'BTCUSDT' },
        { incomeType: 'REALIZED_PNL', income: '-1.30', time: todayStart.getTime() + 7200000, symbol: 'ETHUSDT' },
        { incomeType: 'COMMISSION', income: '-0.10', time: todayStart.getTime() + 3600000, symbol: 'BTCUSDT' },
      ]),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const pnl = await fetcher.getTodayRealizedPnl();

    expect(pnl).toBeCloseTo(3.9); // 5.20 - 1.30 = 3.90 (COMMISSION excluded)
  });

  it('returns 0 when getIncome fails', async () => {
    const mockClient = {
      getIncome: vi.fn().mockRejectedValue(new Error('timeout')),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const pnl = await fetcher.getTodayRealizedPnl();

    expect(pnl).toBe(0);
  });

  it('returns 0 when no income entries exist', async () => {
    const mockClient = {
      getIncome: vi.fn().mockResolvedValue([]),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const pnl = await fetcher.getTodayRealizedPnl();

    expect(pnl).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: FAIL — `getTodayRealizedPnl` method does not exist

**Step 3: Write minimal implementation**

Add to `src/binance/market-data.ts` (after `getPortfolioState()`, around line 217):

```typescript
async getTodayRealizedPnl(): Promise<number> {
  try {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const incomes = await this.client.getIncome({
      incomeType: 'REALIZED_PNL',
      startTime: todayStart.getTime(),
      limit: 1000,
    });

    if (!Array.isArray(incomes) || incomes.length === 0) return 0;

    return incomes.reduce((sum: number, entry: any) => {
      return sum + parseFloat(entry.income || '0');
    }, 0);
  } catch {
    return 0;
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat: add getTodayRealizedPnl() fetching from Binance income history
```

---

### Task 2: Add today's PnL to /api/status endpoint

**Files:**
- Modify: `src/webhook/server.ts` (`/api/status` handler)
- Modify: `tests/webhook/server.test.ts`

**Step 1: Write the failing test**

Add to `tests/webhook/server.test.ts`:

```typescript
it('returns todayRealizedPnl in /api/status', async () => {
  const mockSignalBuffer = { add: vi.fn() } as any;
  const mockLogger = { logDecision: vi.fn() } as any;
  const mockMarketData = {
    getPortfolioState: vi.fn().mockResolvedValue({
      balanceUsd: 100, availableUsd: 80, marginBalanceUsd: 100,
      totalUnrealizedPnl: 0, bnbBalance: 0,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    }),
    getTodayRealizedPnl: vi.fn().mockResolvedValue(3.9),
  } as any;

  const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, {
    marketData: mockMarketData,
  });

  const res = await request(app).get('/api/status');

  expect(res.status).toBe(200);
  expect(res.body.todayRealizedPnl).toBeCloseTo(3.9);
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: FAIL — `todayRealizedPnl` not in response

**Step 3: Write minimal implementation**

In `src/webhook/server.ts`, update the `/api/status` handler:

```typescript
app.get('/api/status', async (_req, res) => {
  if (!deps?.marketData) {
    res.status(503).json({ error: 'Market data not available' });
    return;
  }
  try {
    const [portfolio, todayRealizedPnl] = await Promise.all([
      deps.marketData.getPortfolioState(),
      deps.marketData.getTodayRealizedPnl(),
    ]);
    res.json({
      walletBalance: portfolio.balanceUsd,
      availableBalance: portfolio.availableUsd,
      marginBalance: portfolio.marginBalanceUsd,
      totalUnrealizedPnl: portfolio.totalUnrealizedPnl,
      todayRealizedPnl,
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
feat(dashboard): expose todayRealizedPnl in /api/status
```

---

### Task 3: Clarify PnL labels in LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts` (lines 506-510 — Portfolio section)
- Modify: `src/llm/prompts.ts` (lines 120-159 — `EnrichedPromptData` interface)
- Modify: `src/trading-loop.ts` (around line 498 — add `todayRealizedPnl` to `promptData`)
- Test: prompt tests

**Step 1: Write the failing test**

```typescript
it('uses clear PnL labels in prompt', () => {
  const prompt = buildUserPrompt({
    snapshots: [],
    indicators: new Map(),
    portfolio: {
      balanceUsd: 100, availableUsd: 80, marginBalanceUsd: 95,
      totalUnrealizedPnl: -5, bnbBalance: 0,
      positions: [], sessionPnl: 2.5, drawdownPct: 1,
    },
    signals: [],
    news: [],
    fearGreed: { value: 50, label: 'Neutral' },
    todayRealizedPnl: 3.9,
  });

  expect(prompt).toContain('Session PnL (bot lifetime): +$2.50');
  expect(prompt).toContain('Today Realized PnL (UTC): +$3.90');
  expect(prompt).toContain('Unrealized PnL: -$5.00');
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL — old format uses just `Session PnL`

**Step 3: Write minimal implementation**

In `src/llm/prompts.ts`, add to `EnrichedPromptData` (after `sessionPnlPct`, line 134):

```typescript
todayRealizedPnl?: number;
```

In `buildEnrichedPrompt()`, update the Portfolio section (around line 507):

```typescript
// Portfolio
prompt += '## Portfolio\n';
prompt += `Wallet Balance: $${data.portfolio.balanceUsd.toFixed(2)}\n`;
prompt += `Available (free): $${(data.portfolio.availableUsd ?? data.portfolio.balanceUsd).toFixed(2)}\n`;
if (data.portfolio.marginBalanceUsd !== undefined) {
  prompt += `Margin Balance: $${data.portfolio.marginBalanceUsd.toFixed(2)}\n`;
}
if (data.portfolio.totalUnrealizedPnl !== undefined && data.portfolio.totalUnrealizedPnl !== 0) {
  const sign = data.portfolio.totalUnrealizedPnl >= 0 ? '+' : '-';
  prompt += `Unrealized PnL: ${sign}$${Math.abs(data.portfolio.totalUnrealizedPnl).toFixed(2)}\n`;
}
const sessionSign = data.portfolio.sessionPnl >= 0 ? '+' : '-';
prompt += `Session PnL (bot lifetime): ${sessionSign}$${Math.abs(data.portfolio.sessionPnl).toFixed(2)}\n`;
if (data.todayRealizedPnl !== undefined) {
  const todaySign = data.todayRealizedPnl >= 0 ? '+' : '-';
  prompt += `Today Realized PnL (UTC): ${todaySign}$${Math.abs(data.todayRealizedPnl).toFixed(2)}\n`;
}
```

In `src/trading-loop.ts`, around line 498, add `todayRealizedPnl` to the `promptData` object. Fetch it alongside portfolio:

At the top of `runOnce()`, after `portfolio = await marketData.getPortfolioState()` (line 186):

```typescript
const todayRealizedPnl = await marketData.getTodayRealizedPnl();
```

Then in the `promptData` object (around line 498):

```typescript
const promptData = {
  // ... existing fields
  todayRealizedPnl,
};
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(prompt): clarify PnL labels — session vs today vs unrealized
```

---

### Task 4: Add session PnL to /api/status with sessionStartBalance

**Files:**
- Modify: `src/webhook/server.ts` (extend deps to accept `sessionMemory`)
- Modify: `tests/webhook/server.test.ts`

**Step 1: Write the failing test**

```typescript
it('returns sessionPnl and startBalance in /api/status', async () => {
  const mockSignalBuffer = { add: vi.fn() } as any;
  const mockLogger = { logDecision: vi.fn() } as any;
  const mockMarketData = {
    getPortfolioState: vi.fn().mockResolvedValue({
      balanceUsd: 102.5, availableUsd: 80, marginBalanceUsd: 102.5,
      totalUnrealizedPnl: 0, bnbBalance: 0,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    }),
    getTodayRealizedPnl: vi.fn().mockResolvedValue(0),
  } as any;
  const mockSessionMemory = {
    getStartBalance: vi.fn().mockReturnValue(100),
  } as any;

  const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, {
    marketData: mockMarketData,
    sessionMemory: mockSessionMemory,
  });

  const res = await request(app).get('/api/status');

  expect(res.status).toBe(200);
  expect(res.body.sessionStartBalance).toBe(100);
  expect(res.body.sessionPnl).toBeCloseTo(2.5);
  expect(res.body.sessionPnlPct).toBeCloseTo(2.5);
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: FAIL — `sessionPnl` etc. not in response

**Step 3: Write minimal implementation**

In `src/webhook/server.ts`, extend `WebhookServerDeps`:

```typescript
export interface WebhookServerDeps {
  marketData?: MarketDataFetcher;
  sessionMemory?: { getStartBalance(): number | undefined };
}
```

Update the `/api/status` handler to compute session PnL:

```typescript
const startBalance = deps.sessionMemory?.getStartBalance();
const sessionPnl = startBalance !== undefined ? portfolio.balanceUsd - startBalance : undefined;
const sessionPnlPct = startBalance && startBalance > 0
  ? ((portfolio.balanceUsd - startBalance) / startBalance) * 100
  : undefined;

res.json({
  walletBalance: portfolio.balanceUsd,
  availableBalance: portfolio.availableUsd,
  marginBalance: portfolio.marginBalanceUsd,
  totalUnrealizedPnl: portfolio.totalUnrealizedPnl,
  todayRealizedPnl,
  sessionStartBalance: startBalance,
  sessionPnl,
  sessionPnlPct: sessionPnlPct !== undefined ? parseFloat(sessionPnlPct.toFixed(2)) : undefined,
  bnbBalance: portfolio.bnbBalance,
  positions: portfolio.positions,
  timestamp: new Date().toISOString(),
});
```

In `src/index.ts`, pass `sessionMemory` to the webhook server (update line 184):

```typescript
const app = createWebhookServer(signalBuffer, logger, config.webhook.secret, {
  marketData,
  sessionMemory: memory,
});
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(dashboard): expose session PnL + start balance in /api/status
```
