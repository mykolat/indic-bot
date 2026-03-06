# Dashboard: Show Margin Balance + Unrealized PnL — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add margin balance and total unrealized PnL to the dashboard `/api/status` endpoint so the operator can see the full futures account picture, not just wallet balance.

**Architecture:** Extend `MarketDataFetcher.getPortfolioState()` to call `getAccountInformation()` (Binance Futures API) which returns `totalMarginBalance` and `totalUnrealizedProfit` at the account level. Propagate these new fields through `PortfolioState` to a new `/api/status` endpoint on the webhook server. The dashboard reads this endpoint.

**Tech Stack:** TypeScript, Binance `USDMClient.getAccountInformation()`, Express, Vitest

**Issue:** #2

---

### Task 1: Extend PortfolioState with margin fields

**Files:**
- Modify: `src/risk/manager.ts` (lines 23-29 — `PortfolioState` interface)
- Test: `tests/binance/market-data.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/market-data.test.ts` inside the existing `describe('MarketDataFetcher')` block, after the `'fetches portfolio state'` test (line 57):

```typescript
it('getPortfolioState includes marginBalance and totalUnrealizedPnl', async () => {
  mockClient.getAccountInformation = vi.fn().mockResolvedValue({
    totalMarginBalance: '95.50',
    totalUnrealizedProfit: '-4.50',
    totalWalletBalance: '100.00',
    availableBalance: '80.00',
    assets: [],
    positions: [],
  });

  const state = await fetcher.getPortfolioState();

  expect(state.marginBalanceUsd).toBeCloseTo(95.5);
  expect(state.totalUnrealizedPnl).toBeCloseTo(-4.5);
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: FAIL — `marginBalanceUsd` and `totalUnrealizedPnl` do not exist on `PortfolioState`

**Step 3: Write minimal implementation**

In `src/risk/manager.ts`, extend the `PortfolioState` interface (line 23):

```typescript
export interface PortfolioState {
  balanceUsd: number;      // walletBalance (total, incl. margin locked)
  availableUsd: number;    // availableBalance (free to use)
  marginBalanceUsd: number;       // totalMarginBalance (wallet + unrealized PnL)
  totalUnrealizedPnl: number;    // totalUnrealizedProfit across all positions
  positions: Position[];
  sessionPnl: number;
  drawdownPct: number;
}
```

In `src/binance/market-data.ts`, modify `getPortfolioState()` (line 175) to also call `getAccountInformation()`:

```typescript
async getPortfolioState(): Promise<PortfolioState> {
  const [balances, positions, accountInfo] = await Promise.all([
    this.client.getBalance(),
    this.client.getPositions(),
    this.client.getAccountInformation().catch(() => null),
  ]);

  const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
  const balanceUsd = usdtBalance ? parseFloat(usdtBalance.balance || usdtBalance.walletBalance || '0') : 0;
  const availableUsd = usdtBalance ? parseFloat(usdtBalance.availableBalance) : 0;

  const marginBalanceUsd = accountInfo
    ? parseFloat(accountInfo.totalMarginBalance || '0')
    : balanceUsd;
  const totalUnrealizedPnl = accountInfo
    ? parseFloat(accountInfo.totalUnrealizedProfit || '0')
    : 0;

  const openPositions: Position[] = positions
    .filter((p: any) => parseFloat(p.positionAmt) !== 0)
    .map((p: any) => {
      const notional = Math.abs(parseFloat(p.notional));
      const leverage = parseInt(p.leverage, 10);
      const margin = notional / leverage;
      const unrealizedProfit = parseFloat(p.unRealizedProfit || p.unrealizedProfit || '0');
      const unrealizedPnlPct = margin > 0 ? (unrealizedProfit / margin) * 100 : 0;
      const updateTime = parseInt(p.updateTime || '0', 10);
      const heldHours = updateTime > 0
        ? (Date.now() - updateTime) / 3_600_000
        : 0;

      return {
        pair: p.symbol,
        sizeUsd: notional,
        leverage,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
        entryPrice: parseFloat(p.entryPrice || '0'),
        unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
        heldHours: parseFloat(heldHours.toFixed(1)),
      };
    });

  return {
    balanceUsd,
    availableUsd,
    marginBalanceUsd,
    totalUnrealizedPnl,
    positions: openPositions,
    sessionPnl: 0,
    drawdownPct: 0,
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(dashboard): add marginBalance + unrealizedPnl to PortfolioState
```

---

### Task 2: Add /api/status endpoint to webhook server

**Files:**
- Modify: `src/webhook/server.ts` (add new endpoint + accept dependencies)
- Create: `tests/webhook/server.test.ts`

**Step 1: Write the failing test**

Create `tests/webhook/server.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createWebhookServer } from '../../src/webhook/server.js';

describe('GET /api/status', () => {
  it('returns portfolio state with margin balance and unrealized PnL', async () => {
    const mockSignalBuffer = { add: vi.fn() } as any;
    const mockLogger = { logDecision: vi.fn() } as any;
    const mockMarketData = {
      getPortfolioState: vi.fn().mockResolvedValue({
        balanceUsd: 100,
        availableUsd: 80,
        marginBalanceUsd: 95.5,
        totalUnrealizedPnl: -4.5,
        positions: [
          {
            pair: 'BTCUSDT',
            sizeUsd: 500,
            leverage: 10,
            side: 'LONG',
            entryPrice: 50000,
            unrealizedPnlPct: -2.4,
            heldHours: 1.5,
          },
        ],
        sessionPnl: -1.2,
        drawdownPct: 1.5,
      }),
    } as any;

    const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, {
      marketData: mockMarketData,
    });

    const res = await request(app).get('/api/status');

    expect(res.status).toBe(200);
    expect(res.body.walletBalance).toBe(100);
    expect(res.body.availableBalance).toBe(80);
    expect(res.body.marginBalance).toBeCloseTo(95.5);
    expect(res.body.totalUnrealizedPnl).toBeCloseTo(-4.5);
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.positions[0].pair).toBe('BTCUSDT');
  });

  it('returns 503 when marketData is not provided', async () => {
    const mockSignalBuffer = { add: vi.fn() } as any;
    const mockLogger = { logDecision: vi.fn() } as any;

    const app = createWebhookServer(mockSignalBuffer, mockLogger);

    const res = await request(app).get('/api/status');

    expect(res.status).toBe(503);
    expect(res.body.error).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: FAIL — `/api/status` endpoint does not exist, `supertest` may need installing

Install `supertest` if needed:
```bash
npm install -D supertest @types/supertest
```

**Step 3: Write minimal implementation**

Modify `src/webhook/server.ts`:

```typescript
import express from 'express';
import type { SignalBuffer, TradingViewSignal } from './signal-buffer.js';
import type { Logger } from '../logger/index.js';
import type { MarketDataFetcher } from '../binance/market-data.js';
import { insertWebhookSignal } from '../db/repository.js';

export interface WebhookServerDeps {
  marketData?: MarketDataFetcher;
}

export function createWebhookServer(
  signalBuffer: SignalBuffer,
  logger: Logger,
  secret?: string,
  deps?: WebhookServerDeps,
): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    if (secret && req.headers['x-webhook-secret'] !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { signal, pair, indicator, value, timeframe } = req.body;

    if (!signal || !pair) {
      res.status(400).json({ error: 'Missing signal or pair' });
      return;
    }

    const tvSignal: TradingViewSignal = {
      signal,
      pair,
      indicator: indicator || 'unknown',
      value: value || 0,
      timeframe: timeframe || '1h',
    };

    signalBuffer.add(tvSignal);
    insertWebhookSignal({
      pair: tvSignal.pair || 'UNKNOWN',
      action: tvSignal.signal,
      source: 'tradingview',
      payload: tvSignal,
    }).catch(() => {});
    logger.logDecision({ type: 'WEBHOOK_RECEIVED', ...tvSignal });

    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

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
        positions: portfolio.positions,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch portfolio' });
    }
  });

  return app;
}
```

In `src/index.ts`, update the `createWebhookServer` call (line 184) to pass dependencies:

```typescript
const app = createWebhookServer(signalBuffer, logger, config.webhook.secret, {
  marketData,
});
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(dashboard): add /api/status endpoint with margin balance + unrealized PnL
```

---

### Task 3: Show margin balance in LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts` (lines 506-510 — Portfolio section of `buildEnrichedPrompt`)
- Test: `tests/llm/prompts.test.ts` (if exists, otherwise verify via existing tests)

**Step 1: Write the failing test**

Add to existing prompt tests or create new test:

```typescript
import { describe, it, expect } from 'vitest';
import { buildUserPrompt } from '../../src/llm/prompts.js';

describe('buildUserPrompt portfolio section', () => {
  it('includes margin balance and unrealized PnL when present', () => {
    const prompt = buildUserPrompt({
      snapshots: [],
      indicators: new Map(),
      portfolio: {
        balanceUsd: 100,
        availableUsd: 80,
        marginBalanceUsd: 95.5,
        totalUnrealizedPnl: -4.5,
        positions: [],
        sessionPnl: -1.2,
        drawdownPct: 1.5,
      },
      signals: [],
      news: [],
      fearGreed: { value: 50, label: 'Neutral' },
    });

    expect(prompt).toContain('Margin Balance: $95.50');
    expect(prompt).toContain('Unrealized PnL: -$4.50');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL — prompt does not contain margin balance info

**Step 3: Write minimal implementation**

In `src/llm/prompts.ts`, modify the Portfolio section in `buildEnrichedPrompt()` (around line 506):

```typescript
// Portfolio
prompt += '## Portfolio\n';
prompt += `Wallet Balance: $${data.portfolio.balanceUsd.toFixed(2)}\n`;
prompt += `Available (free): $${(data.portfolio.availableUsd ?? data.portfolio.balanceUsd).toFixed(2)}\n`;
if (data.portfolio.marginBalanceUsd !== undefined) {
  prompt += `Margin Balance: $${data.portfolio.marginBalanceUsd.toFixed(2)}\n`;
}
if (data.portfolio.totalUnrealizedPnl !== undefined && data.portfolio.totalUnrealizedPnl !== 0) {
  const sign = data.portfolio.totalUnrealizedPnl >= 0 ? '' : '-';
  prompt += `Unrealized PnL: ${sign}$${Math.abs(data.portfolio.totalUnrealizedPnl).toFixed(2)}\n`;
}
prompt += `Session PnL: $${data.portfolio.sessionPnl.toFixed(2)}\n`;
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(prompt): show margin balance + unrealized PnL in LLM context
```

---

### Task 4: Fix all existing tests that construct PortfolioState

**Files:**
- Modify: `tests/trading-loop.test.ts` (line 37 — `getPortfolioState` mock)
- Modify: `tests/llm/swarm-agent.test.ts` (any PortfolioState mocks)
- Modify: any other test files that build `PortfolioState`

**Step 1: Find all PortfolioState constructions in tests**
Run: `grep -rn 'sessionPnl.*0\|balanceUsd.*positions' tests/`

**Step 2: Add missing fields to each mock**

In `tests/trading-loop.test.ts` (line 37), update the mock:
```typescript
getPortfolioState: vi.fn().mockResolvedValue({
  balanceUsd: 10, availableUsd: 10, marginBalanceUsd: 10, totalUnrealizedPnl: 0,
  positions: [], sessionPnl: 0, drawdownPct: 0,
}),
```

Repeat for every file that constructs a `PortfolioState` object.

**Step 3: Run full test suite**
Run: `npx vitest run`
Expected: PASS — all tests green

**Step 4: Commit**
```
test: update PortfolioState mocks with margin balance fields
```
