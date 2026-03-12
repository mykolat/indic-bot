# M4 Market Data Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Build a standalone market data platform that provides canonical snapshots, candles, derived features, and event-style anomaly notifications.

**Architecture:** Create `src/platform/market-data/` with market contracts, a Binance-backed provider, a snapshot service, and an HTTP app. Reuse the current `src/binance/market-data.ts` and `src/watchdog.ts` code only as adapters so market access becomes a dedicated platform rather than implicit bot internals.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Market Contracts

**Files:**
- Create: `src/platform/market-data/contracts.ts`
- Test: `tests/platform/market-data/contracts.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import {
  buildSnapshotKey,
  normalizeMarketSnapshot,
} from '../../../src/platform/market-data/contracts.js';

describe('platform/market-data/contracts', () => {
  it('builds stable snapshot keys from pair and timestamp minute', () => {
    expect(buildSnapshotKey('BTCUSDT', '2026-03-12T10:05:31.000Z')).toBe('BTCUSDT::2026-03-12T10:05');
  });

  it('normalizes missing optional fields to null', () => {
    const snapshot = normalizeMarketSnapshot({ pair: 'BTCUSDT', markPrice: 80000 });
    expect(snapshot.openInterest).toBeNull();
    expect(snapshot.fundingRate).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/market-data/contracts.test.ts`

**Step 3: Write minimal implementation**
```typescript
export interface MarketSnapshot {
  pair: string;
  markPrice: number;
  openInterest?: number | null;
  fundingRate?: number | null;
  timestamp?: string;
}

export function buildSnapshotKey(pair: string, timestamp: string): string {
  return `${pair}::${timestamp.slice(0, 16)}`;
}

export function normalizeMarketSnapshot(snapshot: MarketSnapshot): Required<MarketSnapshot> {
  return {
    ...snapshot,
    openInterest: snapshot.openInterest ?? null,
    fundingRate: snapshot.fundingRate ?? null,
    timestamp: snapshot.timestamp ?? new Date().toISOString(),
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/market-data/contracts.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/market-data/contracts.test.ts src/platform/market-data/contracts.ts
git commit -m "feat(m4): add market data contracts #gemini"
```

### Task 2: Binance Provider Adapter

**Files:**
- Create: `src/platform/market-data/binance-provider.ts`
- Modify: `src/binance/market-data.ts`
- Test: `tests/platform/market-data/binance-provider.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { BinanceMarketDataProvider } from '../../../src/platform/market-data/binance-provider.js';

describe('platform/market-data/binance-provider', () => {
  it('maps quick snapshot data into the platform market snapshot shape', async () => {
    const fetcher = {
      getQuickSnapshot: vi.fn().mockResolvedValue({
        pair: 'BTCUSDT',
        markPrice: '80000',
        openInterest: '123456',
        fundingRate: '0.0001',
      }),
    };

    const provider = new BinanceMarketDataProvider(fetcher as any);
    const snapshot = await provider.getSnapshot('BTCUSDT');

    expect(snapshot).toMatchObject({
      pair: 'BTCUSDT',
      markPrice: 80000,
      openInterest: 123456,
      fundingRate: 0.0001,
    });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/market-data/binance-provider.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { normalizeMarketSnapshot, type MarketSnapshot } from './contracts.js';

export class BinanceMarketDataProvider {
  constructor(private fetcher: { getQuickSnapshot(pair: string): Promise<any> }) {}

  async getSnapshot(pair: string): Promise<Required<MarketSnapshot>> {
    const raw = await this.fetcher.getQuickSnapshot(pair);
    return normalizeMarketSnapshot({
      pair: raw.pair,
      markPrice: Number(raw.markPrice),
      openInterest: raw.openInterest ? Number(raw.openInterest) : null,
      fundingRate: raw.fundingRate ? Number(raw.fundingRate) : null,
    });
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/market-data/binance-provider.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/market-data/binance-provider.test.ts src/platform/market-data/binance-provider.ts src/binance/market-data.ts
git commit -m "feat(m4): add binance market data provider #gemini"
```

### Task 3: Snapshot Service + Anomaly Publisher

**Files:**
- Create: `src/platform/market-data/snapshot-store.ts`
- Create: `src/platform/market-data/anomaly-detector.ts`
- Create: `src/platform/market-data/service.ts`
- Test: `tests/platform/market-data/service.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { MarketDataService } from '../../../src/platform/market-data/service.js';

describe('platform/market-data/service', () => {
  it('publishes a price-spike event when price changes more than 2 percent', async () => {
    const provider = {
      getSnapshot: vi.fn()
        .mockResolvedValueOnce({ pair: 'BTCUSDT', markPrice: 80000, openInterest: null, fundingRate: null, timestamp: '2026-03-12T10:00:00Z' })
        .mockResolvedValueOnce({ pair: 'BTCUSDT', markPrice: 81700, openInterest: null, fundingRate: null, timestamp: '2026-03-12T10:01:00Z' }),
    };

    const store = { getLatest: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ markPrice: 80000 }), save: vi.fn().mockResolvedValue(undefined) };
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };

    const service = new MarketDataService({ provider: provider as any, store: store as any, publisher: publisher as any });

    await service.refreshPair('BTCUSDT');
    await service.refreshPair('BTCUSDT');

    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      pair: 'BTCUSDT',
      type: 'PRICE_SPIKE',
    }));
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/market-data/service.test.ts`

**Step 3: Write minimal implementation**
```typescript
export class MarketDataService {
  constructor(private deps: {
    provider: { getSnapshot(pair: string): Promise<any> };
    store: { getLatest(pair: string): Promise<any>; save(snapshot: any): Promise<void> };
    publisher: { publish(event: any): Promise<void> };
  }) {}

  async refreshPair(pair: string): Promise<any> {
    const snapshot = await this.deps.provider.getSnapshot(pair);
    const previous = await this.deps.store.getLatest(pair);

    await this.deps.store.save(snapshot);

    if (previous?.markPrice) {
      const deltaPct = Math.abs(snapshot.markPrice - previous.markPrice) / previous.markPrice * 100;
      if (deltaPct > 2) {
        await this.deps.publisher.publish({
          pair,
          type: 'PRICE_SPIKE',
          detail: `${deltaPct.toFixed(2)}%`,
          snapshot,
        });
      }
    }

    return snapshot;
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/market-data/service.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/market-data/service.test.ts src/platform/market-data/snapshot-store.ts src/platform/market-data/anomaly-detector.ts src/platform/market-data/service.ts
git commit -m "feat(m4): add market snapshot service and anomaly publisher #gemini"
```

### Task 4: HTTP App

**Files:**
- Create: `src/platform/market-data/app.ts`
- Create: `src/platform/market-data/http-server.ts`
- Test: `tests/platform/market-data/app.test.ts`

**Step 1: Write the failing test**
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMarketDataApp } from '../../../src/platform/market-data/app.js';

describe('platform/market-data/app', () => {
  let server: any;
  let baseUrl = '';

  beforeAll(async () => {
    const app = buildMarketDataApp({
      getSnapshot: async (pair: string) => ({ pair, markPrice: 80000 }),
      getFeatures: async (pair: string) => ({ pair, trend: 'up' }),
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

  it('returns snapshots through the platform api', async () => {
    const response = await fetch(`${baseUrl}/market/snapshot/BTCUSDT`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pair: 'BTCUSDT', markPrice: 80000 });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/market-data/app.test.ts`

**Step 3: Write minimal implementation**
```typescript
import express from 'express';

export function buildMarketDataApp(deps: {
  getSnapshot: (pair: string) => Promise<unknown>;
  getFeatures: (pair: string) => Promise<unknown>;
}) {
  const app = express();

  app.get('/market/snapshot/:pair', async (req, res) => {
    res.json(await deps.getSnapshot(req.params.pair));
  });

  app.get('/market/features/:pair', async (req, res) => {
    res.json(await deps.getFeatures(req.params.pair));
  });

  return app;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/market-data/app.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/market-data/app.test.ts src/platform/market-data/app.ts src/platform/market-data/http-server.ts
git commit -m "feat(m4): expose market data http app #gemini"
```

