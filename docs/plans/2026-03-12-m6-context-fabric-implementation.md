# M6 Context Fabric Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Build a context-fabric module that fuses outputs from the platform modules into a canonical `DecisionContext` for strategy consumers.

**Architecture:** Create `src/platform/context-fabric/` with context contracts, platform clients, an assembler service, and an HTTP app. Keep this module policy-neutral: it may merge, compress, and shape signals, but it must not decide `LONG`, `SHORT`, `HOLD`, or `CLOSE`.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: DecisionContext Contracts

**Files:**
- Create: `src/platform/context-fabric/contracts.ts`
- Test: `tests/platform/context-fabric/contracts.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import {
  compactDecisionContext,
  normalizeDecisionContext,
} from '../../../src/platform/context-fabric/contracts.js';

describe('platform/context-fabric/contracts', () => {
  it('normalizes missing collections to empty arrays', () => {
    const context = normalizeDecisionContext({ generatedAt: '2026-03-12T12:00:00Z' });
    expect(context.newsSignals).toEqual([]);
    expect(context.positions).toEqual([]);
  });

  it('builds a compact view suitable for strategy prompts', () => {
    const compact = compactDecisionContext({
      generatedAt: '2026-03-12T12:00:00Z',
      newsSignals: [{ catalyst: 'ETF approval', importance: 9 }],
      positions: [{ pair: 'BTCUSDT', notionalUsd: 500 }],
      market: [{ pair: 'BTCUSDT', markPrice: 80000 }],
      memory: [],
    });

    expect(compact.topSignal?.catalyst).toBe('ETF approval');
    expect(compact.openPairs).toEqual(['BTCUSDT']);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/context-fabric/contracts.test.ts`

**Step 3: Write minimal implementation**
```typescript
export interface DecisionContext {
  generatedAt: string;
  newsSignals?: Array<{ catalyst: string; importance: number }>;
  positions?: Array<{ pair: string; notionalUsd: number }>;
  market?: Array<{ pair: string; markPrice: number }>;
  memory?: Array<{ summary: string }>;
}

export function normalizeDecisionContext(context: DecisionContext): Required<DecisionContext> {
  return {
    ...context,
    newsSignals: context.newsSignals ?? [],
    positions: context.positions ?? [],
    market: context.market ?? [],
    memory: context.memory ?? [],
  };
}

export function compactDecisionContext(context: Required<DecisionContext>) {
  const topSignal = [...context.newsSignals].sort((a, b) => b.importance - a.importance)[0] ?? null;
  const openPairs = context.positions.map((position) => position.pair);
  return { topSignal, openPairs, generatedAt: context.generatedAt };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/context-fabric/contracts.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/context-fabric/contracts.test.ts src/platform/context-fabric/contracts.ts
git commit -m "feat(m6): add context fabric contracts #gemini"
```

### Task 2: Platform Clients

**Files:**
- Create: `src/platform/context-fabric/platform-clients.ts`
- Test: `tests/platform/context-fabric/platform-clients.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import { buildPlatformUrls } from '../../../src/platform/context-fabric/platform-clients.js';

describe('platform/context-fabric/platform-clients', () => {
  it('builds stable endpoint urls for dependent modules', () => {
    const urls = buildPlatformUrls({
      newsIntelligenceBaseUrl: 'http://m3.local',
      marketDataBaseUrl: 'http://m4.local',
      accountStateBaseUrl: 'http://m5.local',
    });

    expect(urls.newsSignals).toBe('http://m3.local/news/signals');
    expect(urls.marketSnapshot('BTCUSDT')).toBe('http://m4.local/market/snapshot/BTCUSDT');
    expect(urls.accountState).toBe('http://m5.local/account/state');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/context-fabric/platform-clients.test.ts`

**Step 3: Write minimal implementation**
```typescript
export function buildPlatformUrls(config: {
  newsIntelligenceBaseUrl: string;
  marketDataBaseUrl: string;
  accountStateBaseUrl: string;
}) {
  return {
    newsSignals: `${config.newsIntelligenceBaseUrl}/news/signals`,
    marketSnapshot: (pair: string) => `${config.marketDataBaseUrl}/market/snapshot/${pair}`,
    accountState: `${config.accountStateBaseUrl}/account/state`,
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/context-fabric/platform-clients.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/context-fabric/platform-clients.test.ts src/platform/context-fabric/platform-clients.ts
git commit -m "feat(m6): add context fabric platform clients #gemini"
```

### Task 3: Context Assembler Service

**Files:**
- Create: `src/platform/context-fabric/memory-adapter.ts`
- Create: `src/platform/context-fabric/service.ts`
- Modify: `src/memory/session.ts`
- Modify: `src/memory/episodic-store.ts`
- Test: `tests/platform/context-fabric/service.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { ContextFabricService } from '../../../src/platform/context-fabric/service.js';

describe('platform/context-fabric/service', () => {
  it('assembles a decision context from news, market, account, and memory', async () => {
    const service = new ContextFabricService({
      news: { getSignals: vi.fn().mockResolvedValue([{ catalyst: 'ETF approval', importance: 9 }]) },
      market: { getSnapshots: vi.fn().mockResolvedValue([{ pair: 'BTCUSDT', markPrice: 80000 }]) },
      account: { getState: vi.fn().mockResolvedValue({ positions: [{ pair: 'BTCUSDT', notionalUsd: 500 }] }) },
      memory: { getRecent: vi.fn().mockResolvedValue([{ summary: 'ETF headlines usually create follow-through' }]) },
    });

    const context = await service.build({ pairs: ['BTCUSDT'] });

    expect(context.newsSignals).toHaveLength(1);
    expect(context.market[0].pair).toBe('BTCUSDT');
    expect(context.positions[0].pair).toBe('BTCUSDT');
    expect(context.memory).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/context-fabric/service.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { normalizeDecisionContext } from './contracts.js';

export class ContextFabricService {
  constructor(private deps: {
    news: { getSignals(): Promise<any[]> };
    market: { getSnapshots(pairs: string[]): Promise<any[]> };
    account: { getState(): Promise<{ positions?: any[] }> };
    memory: { getRecent(limit?: number): Promise<any[]> };
  }) {}

  async build(input: { pairs: string[] }) {
    const [newsSignals, market, account, memory] = await Promise.all([
      this.deps.news.getSignals(),
      this.deps.market.getSnapshots(input.pairs),
      this.deps.account.getState(),
      this.deps.memory.getRecent(10),
    ]);

    return normalizeDecisionContext({
      generatedAt: new Date().toISOString(),
      newsSignals,
      market,
      positions: account.positions ?? [],
      memory,
    });
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/context-fabric/service.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/context-fabric/service.test.ts src/platform/context-fabric/memory-adapter.ts src/platform/context-fabric/service.ts src/memory/session.ts src/memory/episodic-store.ts
git commit -m "feat(m6): add context fabric assembler service #gemini"
```

### Task 4: HTTP App + Bot Client

**Files:**
- Create: `src/platform/context-fabric/app.ts`
- Create: `src/platform/context-fabric/http-server.ts`
- Create: `src/platform/context-fabric/bot-client.ts`
- Modify: `src/trading-loop.ts`
- Test: `tests/platform/context-fabric/app.test.ts`

**Step 1: Write the failing test**
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContextFabricApp } from '../../../src/platform/context-fabric/app.js';

describe('platform/context-fabric/app', () => {
  let server: any;
  let baseUrl = '';

  beforeAll(async () => {
    const app = buildContextFabricApp({
      buildContext: async () => ({
        generatedAt: '2026-03-12T12:00:00Z',
        newsSignals: [],
        positions: [],
        market: [],
        memory: [],
      }),
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

  it('returns a decision context', async () => {
    const response = await fetch(`${baseUrl}/context/trading`);
    expect(response.status).toBe(200);
    expect((await response.json()).generatedAt).toBe('2026-03-12T12:00:00Z');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/context-fabric/app.test.ts`

**Step 3: Write minimal implementation**
```typescript
import express from 'express';

export function buildContextFabricApp(deps: {
  buildContext: (query?: any) => Promise<unknown>;
}) {
  const app = express();

  app.get('/context/trading', async (req, res) => {
    res.json(await deps.buildContext(req.query));
  });

  return app;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/context-fabric/app.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/context-fabric/app.test.ts src/platform/context-fabric/app.ts src/platform/context-fabric/http-server.ts src/platform/context-fabric/bot-client.ts src/trading-loop.ts
git commit -m "feat(m6): expose context fabric api and bot client #gemini"
```

