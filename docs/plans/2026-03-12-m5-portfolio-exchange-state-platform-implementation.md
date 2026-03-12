# M5 Portfolio / Exchange State Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Build a platform module that owns canonical account state, position snapshots, order snapshots, and reconciliation against the exchange.

**Architecture:** Create `src/platform/account-state/` with account contracts, a Binance-backed provider, a reconciliation service, and an HTTP app. Reuse existing portfolio-state reads, user-stream handling, and position reconciliation code only as adapters so exchange state becomes a first-class platform dependency instead of a side effect inside the trading loop.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Account-State Contracts

**Files:**
- Create: `src/platform/account-state/contracts.ts`
- Test: `tests/platform/account-state/contracts.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import {
  normalizeAccountState,
  totalOpenExposureUsd,
} from '../../../src/platform/account-state/contracts.js';

describe('platform/account-state/contracts', () => {
  it('normalizes missing collections to empty arrays', () => {
    const state = normalizeAccountState({ balanceUsd: 1000 });
    expect(state.positions).toEqual([]);
    expect(state.orders).toEqual([]);
  });

  it('computes total open exposure from positions', () => {
    const exposure = totalOpenExposureUsd({
      balanceUsd: 1000,
      positions: [{ pair: 'BTCUSDT', notionalUsd: 600 }],
      orders: [],
    });
    expect(exposure).toBe(600);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/account-state/contracts.test.ts`

**Step 3: Write minimal implementation**
```typescript
export interface PositionSnapshot {
  pair: string;
  notionalUsd: number;
}

export interface OrderSnapshot {
  pair: string;
  side: string;
}

export interface AccountState {
  balanceUsd: number;
  positions?: PositionSnapshot[];
  orders?: OrderSnapshot[];
}

export function normalizeAccountState(state: AccountState): Required<AccountState> {
  return {
    ...state,
    positions: state.positions ?? [],
    orders: state.orders ?? [],
  };
}

export function totalOpenExposureUsd(state: Required<AccountState>): number {
  return state.positions.reduce((sum, position) => sum + position.notionalUsd, 0);
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/account-state/contracts.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/account-state/contracts.test.ts src/platform/account-state/contracts.ts
git commit -m "feat(m5): add account-state contracts #gemini"
```

### Task 2: Binance Account Provider

**Files:**
- Create: `src/platform/account-state/binance-provider.ts`
- Modify: `src/binance/market-data.ts`
- Test: `tests/platform/account-state/binance-provider.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { BinanceAccountStateProvider } from '../../../src/platform/account-state/binance-provider.js';

describe('platform/account-state/binance-provider', () => {
  it('maps portfolio state into canonical account state', async () => {
    const marketData = {
      getPortfolioState: vi.fn().mockResolvedValue({
        balanceUsd: 1000,
        positions: [{ pair: 'BTCUSDT', sizeUsd: 500 }],
      }),
    };

    const provider = new BinanceAccountStateProvider(marketData as any);
    const state = await provider.getAccountState();

    expect(state.balanceUsd).toBe(1000);
    expect(state.positions[0]).toEqual({ pair: 'BTCUSDT', notionalUsd: 500 });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/account-state/binance-provider.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { normalizeAccountState } from './contracts.js';

export class BinanceAccountStateProvider {
  constructor(private marketData: { getPortfolioState(): Promise<any> }) {}

  async getAccountState() {
    const portfolio = await this.marketData.getPortfolioState();
    return normalizeAccountState({
      balanceUsd: portfolio.balanceUsd,
      positions: (portfolio.positions ?? []).map((position: any) => ({
        pair: position.pair,
        notionalUsd: position.sizeUsd,
      })),
      orders: [],
    });
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/account-state/binance-provider.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/account-state/binance-provider.test.ts src/platform/account-state/binance-provider.ts src/binance/market-data.ts
git commit -m "feat(m5): add binance account-state provider #gemini"
```

### Task 3: Reconciliation Service

**Files:**
- Create: `src/platform/account-state/read-model-store.ts`
- Create: `src/platform/account-state/reconciliation-service.ts`
- Modify: `src/position-reconciler.ts`
- Test: `tests/platform/account-state/reconciliation-service.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { ReconciliationService } from '../../../src/platform/account-state/reconciliation-service.js';

describe('platform/account-state/reconciliation-service', () => {
  it('emits drift when exchange and stored positions disagree', async () => {
    const provider = {
      getAccountState: vi.fn().mockResolvedValue({
        balanceUsd: 1000,
        positions: [{ pair: 'BTCUSDT', notionalUsd: 500 }],
        orders: [],
      }),
    };

    const store = {
      getLatest: vi.fn().mockResolvedValue({
        balanceUsd: 1000,
        positions: [],
        orders: [],
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const service = new ReconciliationService({ provider: provider as any, store: store as any });
    const result = await service.reconcile();

    expect(result.hasDrift).toBe(true);
    expect(store.save).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/account-state/reconciliation-service.test.ts`

**Step 3: Write minimal implementation**
```typescript
export class ReconciliationService {
  constructor(private deps: {
    provider: { getAccountState(): Promise<any> };
    store: { getLatest(): Promise<any>; save(state: any): Promise<void> };
  }) {}

  async reconcile(): Promise<{ hasDrift: boolean; current: any }> {
    const current = await this.deps.provider.getAccountState();
    const previous = await this.deps.store.getLatest();
    const hasDrift = JSON.stringify(current.positions) !== JSON.stringify(previous?.positions ?? []);
    await this.deps.store.save(current);
    return { hasDrift, current };
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/account-state/reconciliation-service.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/account-state/reconciliation-service.test.ts src/platform/account-state/read-model-store.ts src/platform/account-state/reconciliation-service.ts src/position-reconciler.ts
git commit -m "feat(m5): add account-state reconciliation service #gemini"
```

### Task 4: HTTP App

**Files:**
- Create: `src/platform/account-state/app.ts`
- Create: `src/platform/account-state/http-server.ts`
- Test: `tests/platform/account-state/app.test.ts`

**Step 1: Write the failing test**
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAccountStateApp } from '../../../src/platform/account-state/app.js';

describe('platform/account-state/app', () => {
  let server: any;
  let baseUrl = '';

  beforeAll(async () => {
    const app = buildAccountStateApp({
      getState: async () => ({ balanceUsd: 1000, positions: [], orders: [] }),
      getPositions: async () => [],
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns account state via platform api', async () => {
    const response = await fetch(`${baseUrl}/account/state`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ balanceUsd: 1000, positions: [], orders: [] });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/account-state/app.test.ts`

**Step 3: Write minimal implementation**
```typescript
import express from 'express';

export function buildAccountStateApp(deps: {
  getState: () => Promise<unknown>;
  getPositions: () => Promise<unknown[]>;
}) {
  const app = express();

  app.get('/account/state', async (_req, res) => {
    res.json(await deps.getState());
  });

  app.get('/account/positions', async (_req, res) => {
    res.json({ items: await deps.getPositions() });
  });

  return app;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/account-state/app.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/account-state/app.test.ts src/platform/account-state/app.ts src/platform/account-state/http-server.ts
git commit -m "feat(m5): expose account-state http app #gemini"
```

