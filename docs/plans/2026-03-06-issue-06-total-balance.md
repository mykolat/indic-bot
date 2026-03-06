# LLM Sees Only USDT Balance, Misses ~$24 in BNB + Earn Products — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Include BNB and earn product balances in the total balance calculation so the LLM has an accurate picture of the operator's capital, not just the USDT futures wallet balance.

**Architecture:** Binance `getBalance()` returns all assets in the futures wallet (USDT, BNB, BUSD, etc.). Currently only `USDT` is extracted. We compute `totalAccountValueUsd` by summing all asset balances converted to USD (BNB via its mark price). This total is added to `PortfolioState` and displayed in the LLM prompt alongside the USDT balance, giving the LLM a complete picture. For earn/staking products we add a note in the prompt if the operator has configured an `EARN_BALANCE_USD` env var (since Binance Futures API cannot query Earn balances — that requires the Spot API).

**Tech Stack:** TypeScript, Binance `USDMClient.getBalance()` + `USDMClient.getMarkPrice()`, Vitest

**Issue:** #6

---

### Task 1: Compute total account value across all futures assets

**Files:**
- Modify: `src/risk/manager.ts` (line 23 — `PortfolioState` interface)
- Modify: `src/binance/market-data.ts` (line 175 — `getPortfolioState()`)
- Test: `tests/binance/market-data.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/market-data.test.ts`:

```typescript
describe('MarketDataFetcher total account value', () => {
  it('computes totalAccountValueUsd from USDT + BNB (converted to USD)', async () => {
    const mockClient = {
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '100.00', availableBalance: '80.00' },
        { asset: 'BNB', balance: '0.05', availableBalance: '0.05' },
      ]),
      getPositions: vi.fn().mockResolvedValue([]),
      getAccountInformation: vi.fn().mockResolvedValue({
        totalMarginBalance: '100.00',
        totalUnrealizedProfit: '0',
        assets: [],
        positions: [],
      }),
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: '600.00' }),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const state = await fetcher.getPortfolioState();

    // 100 USDT + 0.05 BNB * $600 = 100 + 30 = 130
    expect(state.totalAccountValueUsd).toBeCloseTo(130);
  });

  it('falls back to USDT-only when BNB price fetch fails', async () => {
    const mockClient = {
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '100.00', availableBalance: '80.00' },
        { asset: 'BNB', balance: '0.05', availableBalance: '0.05' },
      ]),
      getPositions: vi.fn().mockResolvedValue([]),
      getAccountInformation: vi.fn().mockResolvedValue({
        totalMarginBalance: '100.00',
        totalUnrealizedProfit: '0',
        assets: [],
        positions: [],
      }),
      getMarkPrice: vi.fn().mockRejectedValue(new Error('not found')),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const state = await fetcher.getPortfolioState();

    // Falls back to just USDT
    expect(state.totalAccountValueUsd).toBeCloseTo(100);
  });

  it('handles account with only USDT', async () => {
    const mockClient = {
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '50.00', availableBalance: '50.00' },
      ]),
      getPositions: vi.fn().mockResolvedValue([]),
      getAccountInformation: vi.fn().mockResolvedValue({
        totalMarginBalance: '50.00',
        totalUnrealizedProfit: '0',
        assets: [],
        positions: [],
      }),
      getMarkPrice: vi.fn(),
    };

    const fetcher = new MarketDataFetcher(mockClient);
    const state = await fetcher.getPortfolioState();

    expect(state.totalAccountValueUsd).toBeCloseTo(50);
    expect(mockClient.getMarkPrice).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/binance/market-data.test.ts`
Expected: FAIL — `totalAccountValueUsd` does not exist on `PortfolioState`

**Step 3: Write minimal implementation**

In `src/risk/manager.ts`, add to `PortfolioState`:

```typescript
export interface PortfolioState {
  balanceUsd: number;           // USDT walletBalance
  availableUsd: number;         // USDT availableBalance
  marginBalanceUsd: number;     // totalMarginBalance
  totalUnrealizedPnl: number;   // totalUnrealizedProfit
  bnbBalance: number;           // BNB in futures wallet
  totalAccountValueUsd: number; // all assets converted to USD
  positions: Position[];
  sessionPnl: number;
  drawdownPct: number;
}
```

In `src/binance/market-data.ts`, update `getPortfolioState()`:

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

  const bnbAsset = balances.find((b: any) => b.asset === 'BNB');
  const bnbBalance = bnbAsset ? parseFloat(bnbAsset.balance || '0') : 0;

  const marginBalanceUsd = accountInfo
    ? parseFloat(accountInfo.totalMarginBalance || '0')
    : balanceUsd;
  const totalUnrealizedPnl = accountInfo
    ? parseFloat(accountInfo.totalUnrealizedProfit || '0')
    : 0;

  // Convert non-USDT assets to USD
  let totalAccountValueUsd = balanceUsd;

  // Collect non-USDT, non-zero assets
  const nonUsdtAssets = balances.filter(
    (b: any) => b.asset !== 'USDT' && b.asset !== 'BUSD' && parseFloat(b.balance || '0') > 0
  );

  if (nonUsdtAssets.length > 0) {
    // Fetch BNB price (most common non-USDT asset in futures)
    for (const asset of nonUsdtAssets) {
      const symbol = `${asset.asset}USDT`;
      const balance = parseFloat(asset.balance || '0');
      try {
        const priceData = await this.client.getMarkPrice({ symbol });
        const price = parseFloat(priceData.markPrice);
        totalAccountValueUsd += balance * price;
      } catch {
        // Can't convert — skip this asset's USD value
        // (e.g. no XYZUSDT futures pair exists)
      }
    }
  }

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
        unrealizedPnlUsd: parseFloat(unrealizedProfit.toFixed(2)),
        marginUsd: parseFloat(margin.toFixed(2)),
        heldHours: parseFloat(heldHours.toFixed(1)),
      };
    });

  return {
    balanceUsd,
    availableUsd,
    marginBalanceUsd,
    totalUnrealizedPnl,
    bnbBalance,
    totalAccountValueUsd: parseFloat(totalAccountValueUsd.toFixed(2)),
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
feat: compute totalAccountValueUsd from all futures wallet assets
```

---

### Task 2: Show total account value in LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts` (Portfolio section in `buildEnrichedPrompt`, around line 507)
- Modify: `src/llm/prompts.ts` (`EnrichedPromptData` interface, add `earnBalanceUsd`)
- Modify: `src/trading-loop.ts` (pass `earnBalanceUsd` into promptData)
- Test: prompt tests

**Step 1: Write the failing test**

```typescript
it('shows total account value and earn balance in prompt', () => {
  const prompt = buildUserPrompt({
    snapshots: [],
    indicators: new Map(),
    portfolio: {
      balanceUsd: 100,
      availableUsd: 80,
      marginBalanceUsd: 100,
      totalUnrealizedPnl: 0,
      bnbBalance: 0.05,
      totalAccountValueUsd: 130,
      positions: [],
      sessionPnl: 0,
      drawdownPct: 0,
    },
    signals: [],
    news: [],
    fearGreed: { value: 50, label: 'Neutral' },
    earnBalanceUsd: 24,
  });

  expect(prompt).toContain('Total Account Value (futures): $130.00');
  expect(prompt).toContain('Earn/Staking (off-exchange): ~$24.00');
  expect(prompt).toContain('BNB: 0.0500');
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL — prompt doesn't contain these labels

**Step 3: Write minimal implementation**

In `src/llm/prompts.ts`, add to `EnrichedPromptData` (around line 134):

```typescript
earnBalanceUsd?: number;  // from EARN_BALANCE_USD env var — manually configured
```

In `buildEnrichedPrompt()`, update the Portfolio section (around line 507):

```typescript
// Portfolio
prompt += '## Portfolio\n';
prompt += `Wallet Balance (USDT): $${data.portfolio.balanceUsd.toFixed(2)}\n`;
prompt += `Available (free): $${(data.portfolio.availableUsd ?? data.portfolio.balanceUsd).toFixed(2)}\n`;
if (data.portfolio.marginBalanceUsd !== undefined) {
  prompt += `Margin Balance: $${data.portfolio.marginBalanceUsd.toFixed(2)}\n`;
}
if (data.portfolio.totalAccountValueUsd !== undefined) {
  prompt += `Total Account Value (futures): $${data.portfolio.totalAccountValueUsd.toFixed(2)}\n`;
}
if (data.portfolio.bnbBalance !== undefined && data.portfolio.bnbBalance > 0) {
  prompt += `BNB: ${data.portfolio.bnbBalance.toFixed(4)} (fee discount asset)\n`;
}
if (data.earnBalanceUsd !== undefined && data.earnBalanceUsd > 0) {
  prompt += `Earn/Staking (off-exchange): ~$${data.earnBalanceUsd.toFixed(2)}\n`;
}
if (data.portfolio.totalUnrealizedPnl !== undefined && data.portfolio.totalUnrealizedPnl !== 0) {
  const sign = data.portfolio.totalUnrealizedPnl >= 0 ? '+' : '-';
  prompt += `Unrealized PnL: ${sign}$${Math.abs(data.portfolio.totalUnrealizedPnl).toFixed(2)}\n`;
}
const sessionSign = data.portfolio.sessionPnl >= 0 ? '+' : '-';
prompt += `Session PnL (bot lifetime): ${sessionSign}$${Math.abs(data.portfolio.sessionPnl).toFixed(2)}\n`;
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: PASS

**Step 5: Commit**
```
feat(prompt): show total account value + BNB + earn in LLM context
```

---

### Task 3: Wire earn balance from config into trading loop

**Files:**
- Modify: `src/config.ts` (add `earnBalanceUsd` to `Config.trading`)
- Modify: `src/trading-loop.ts` (pass to promptData)
- Test: config test or integration test

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('config earnBalanceUsd', () => {
  it('reads EARN_BALANCE_USD from config.yaml trading section', async () => {
    vi.stubEnv('BINANCE_API_KEY', 'test');
    vi.stubEnv('BINANCE_API_SECRET', 'test');

    // Mock fs to return a config.yaml with earnBalanceUsd
    const { loadConfig } = await import('../../src/config.js');
    // This test validates the field exists on Config type
    const config = loadConfig();
    expect(config.trading.earnBalanceUsd).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `earnBalanceUsd` not in `Config.trading`

**Step 3: Write minimal implementation**

In `src/config.ts`, add to the `trading` section of the `Config` interface (after `fearGreedLeverageCap`, line 47):

```typescript
earnBalanceUsd: number;  // manually configured non-futures balance (Earn, Staking, etc.)
```

In `loadConfig()`, add to the trading object (after `fearGreedLeverageCap`, line 113):

```typescript
earnBalanceUsd: t.earnBalanceUsd ?? 0,
```

In `config.yaml`, add an optional field:

```yaml
trading:
  # ... existing fields
  earnBalanceUsd: 24  # approximate USD in Earn/Staking products
```

In `src/trading-loop.ts`, add `earnBalanceUsd` to `TradingLoopDeps.tradingConfig`:

```typescript
tradingConfig: {
  // ... existing fields
  earnBalanceUsd?: number;
};
```

In the `promptData` object (around line 498), add:

```typescript
const promptData = {
  // ... existing fields
  earnBalanceUsd: this.deps.tradingConfig.earnBalanceUsd,
};
```

In `src/index.ts`, pass it through when constructing the loop (around line 234):

```typescript
tradingConfig: {
  ...promptConfig,
  stalePositionHours: config.trading.stalePositionHours,
  maxHoldHours: config.trading.maxHoldHours,
  earnBalanceUsd: config.trading.earnBalanceUsd,
},
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**
```
feat: wire earnBalanceUsd from config.yaml into LLM prompt
```

---

### Task 4: Expose total account value in /api/status

**Files:**
- Modify: `src/webhook/server.ts` (`/api/status` handler)
- Modify: `tests/webhook/server.test.ts`

**Step 1: Write the failing test**

```typescript
it('returns totalAccountValueUsd in /api/status', async () => {
  const mockSignalBuffer = { add: vi.fn() } as any;
  const mockLogger = { logDecision: vi.fn() } as any;
  const mockMarketData = {
    getPortfolioState: vi.fn().mockResolvedValue({
      balanceUsd: 100, availableUsd: 80, marginBalanceUsd: 100,
      totalUnrealizedPnl: 0, bnbBalance: 0.05,
      totalAccountValueUsd: 130,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    }),
    getTodayRealizedPnl: vi.fn().mockResolvedValue(0),
  } as any;

  const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, {
    marketData: mockMarketData,
  });

  const res = await request(app).get('/api/status');

  expect(res.status).toBe(200);
  expect(res.body.totalAccountValueUsd).toBeCloseTo(130);
});
```

**Step 2: Run test to verify it passes (no code change needed)**

The `/api/status` endpoint should already include `totalAccountValueUsd` if we add it to the response in the handler. Update the handler to include it:

```typescript
res.json({
  walletBalance: portfolio.balanceUsd,
  availableBalance: portfolio.availableUsd,
  marginBalance: portfolio.marginBalanceUsd,
  totalAccountValueUsd: portfolio.totalAccountValueUsd,
  totalUnrealizedPnl: portfolio.totalUnrealizedPnl,
  todayRealizedPnl,
  bnbBalance: portfolio.bnbBalance,
  sessionStartBalance: startBalance,
  sessionPnl,
  sessionPnlPct: sessionPnlPct !== undefined ? parseFloat(sessionPnlPct.toFixed(2)) : undefined,
  positions: portfolio.positions,
  timestamp: new Date().toISOString(),
});
```

**Step 3: Run test to verify it passes**
Run: `npx vitest run tests/webhook/server.test.ts`
Expected: PASS

**Step 4: Commit**
```
feat(dashboard): expose totalAccountValueUsd in /api/status
```

---

### Task 5: Update all test mocks

**Files:**
- Modify: all test files constructing `PortfolioState`

**Step 1: Find all PortfolioState constructions**
Run: `grep -rn 'balanceUsd.*positions\|sessionPnl.*0' tests/`

**Step 2: Add missing fields**

For every `PortfolioState` mock, add:
```typescript
totalAccountValueUsd: 100,  // same as balanceUsd if no other assets
```

**Step 3: Run full test suite**
Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**
```
test: update PortfolioState mocks with totalAccountValueUsd
```
