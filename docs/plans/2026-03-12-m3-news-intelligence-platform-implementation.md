# M3 News Intelligence Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Build a news intelligence platform that turns raw articles into ranked, grounded, decision-grade news signals that can be consumed by other modules.

**Architecture:** Create `src/platform/news-intelligence/` with explicit signal contracts, deterministic ranking, an LLM-backed analyzer, and an HTTP app. Reuse existing `src/news/news-analyst.ts`, `src/news/grok-grounder.ts`, and `src/news/news-market-fusion.ts` only as adapters so this module owns the meaning of news rather than raw ingestion.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Signal Contracts

**Files:**
- Create: `src/platform/news-intelligence/contracts.ts`
- Test: `tests/platform/news-intelligence/contracts.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import {
  buildNewsSignalId,
  normalizeNewsSignal,
} from '../../../src/platform/news-intelligence/contracts.js';

describe('platform/news-intelligence/contracts', () => {
  it('builds signal ids from article identity and catalyst', () => {
    expect(buildNewsSignalId('article-1', 'ETF approval')).toBe('article-1::ETF approval');
  });

  it('defaults related pairs and tags to empty arrays', () => {
    const signal = normalizeNewsSignal({
      articleId: 'article-1',
      catalyst: 'ETF approval',
      importance: 8,
    });

    expect(signal.relatedPairs).toEqual([]);
    expect(signal.tags).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-intelligence/contracts.test.ts`

**Step 3: Write minimal implementation**
```typescript
export interface NewsSignal {
  articleId: string;
  catalyst: string;
  importance: number;
  summary?: string;
  verified?: boolean | null;
  relatedPairs?: string[];
  tags?: string[];
}

export function buildNewsSignalId(articleId: string, catalyst: string): string {
  return `${articleId}::${catalyst}`;
}

export function normalizeNewsSignal(signal: NewsSignal): NewsSignal {
  return {
    ...signal,
    relatedPairs: signal.relatedPairs ?? [],
    tags: signal.tags ?? [],
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-intelligence/contracts.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-intelligence/contracts.test.ts src/platform/news-intelligence/contracts.ts
git commit -m "feat(m3): add news intelligence contracts #gemini"
```

### Task 2: Deterministic Ranking Layer

**Files:**
- Create: `src/platform/news-intelligence/ranker.ts`
- Test: `tests/platform/news-intelligence/ranker.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import { rankArticles } from '../../../src/platform/news-intelligence/ranker.js';

describe('platform/news-intelligence/ranker', () => {
  it('ranks fresher titled catalyst articles above generic stale ones', () => {
    const ranked = rankArticles([
      { title: 'Market update', source: 'RSS', publishedAt: '2026-03-11T00:00:00Z' },
      { title: 'SEC approves BTC ETF', source: 'RSS', publishedAt: '2026-03-12T10:00:00Z' },
    ]);

    expect(ranked[0].title).toBe('SEC approves BTC ETF');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-intelligence/ranker.test.ts`

**Step 3: Write minimal implementation**
```typescript
export function rankArticles<T extends { title: string; publishedAt?: string }>(articles: T[]) {
  const now = Date.now();

  return [...articles]
    .map((article) => {
      const ageHours = article.publishedAt
        ? Math.max(1, (now - new Date(article.publishedAt).getTime()) / 3_600_000)
        : 24;
      const keywordBoost = /(approve|lawsuit|hack|liquidation|etf|fed)/i.test(article.title) ? 5 : 0;
      const freshnessBoost = Math.max(0, 10 - ageHours);
      return { ...article, score: keywordBoost + freshnessBoost };
    })
    .sort((a, b) => b.score - a.score);
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-intelligence/ranker.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-intelligence/ranker.test.ts src/platform/news-intelligence/ranker.ts
git commit -m "feat(m3): add deterministic news ranking layer #gemini"
```

### Task 3: Analyzer Service + Grounding Adapter

**Files:**
- Create: `src/platform/news-intelligence/service.ts`
- Modify: `src/news/news-analyst.ts`
- Modify: `src/news/grok-grounder.ts`
- Test: `tests/platform/news-intelligence/service.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { NewsIntelligenceService } from '../../../src/platform/news-intelligence/service.js';

describe('platform/news-intelligence/service', () => {
  it('analyzes the top ranked articles and returns normalized signals', async () => {
    const analyzer = {
      analyze: vi.fn().mockResolvedValue([
        { articleId: 'a-1', catalyst: 'ETF approval', importance: 9, relatedPairs: ['BTCUSDT'] },
      ]),
    };

    const grounder = {
      verify: vi.fn().mockResolvedValue({ verified: true, summary: 'confirmed' }),
    };

    const service = new NewsIntelligenceService({ analyzer: analyzer as any, grounder: grounder as any });
    const signals = await service.analyze([
      { id: 'a-1', title: 'SEC approves BTC ETF', score: 12 },
    ] as any);

    expect(signals[0]).toMatchObject({
      articleId: 'a-1',
      catalyst: 'ETF approval',
      verified: true,
    });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-intelligence/service.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { normalizeNewsSignal, type NewsSignal } from './contracts.js';

export class NewsIntelligenceService {
  constructor(private deps: {
    analyzer: { analyze(input: unknown[]): Promise<NewsSignal[]> };
    grounder: { verify(claim: string): Promise<{ verified?: boolean | null; summary?: string }> };
  }) {}

  async analyze(articles: Array<{ id: string; title: string; score: number }>): Promise<NewsSignal[]> {
    const rawSignals = await this.deps.analyzer.analyze(articles);
    const normalized: NewsSignal[] = [];

    for (const signal of rawSignals) {
      const grounding = await this.deps.grounder.verify(signal.catalyst);
      normalized.push(
        normalizeNewsSignal({
          ...signal,
          verified: grounding.verified ?? null,
          summary: grounding.summary ?? signal.summary,
        }),
      );
    }

    return normalized;
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-intelligence/service.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-intelligence/service.test.ts src/platform/news-intelligence/service.ts src/news/news-analyst.ts src/news/grok-grounder.ts
git commit -m "feat(m3): add news intelligence service and grounding adapter #gemini"
```

### Task 4: HTTP App

**Files:**
- Create: `src/platform/news-intelligence/app.ts`
- Create: `src/platform/news-intelligence/http-server.ts`
- Test: `tests/platform/news-intelligence/app.test.ts`

**Step 1: Write the failing test**
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNewsIntelligenceApp } from '../../../src/platform/news-intelligence/app.js';

describe('platform/news-intelligence/app', () => {
  let server: any;
  let baseUrl = '';

  beforeAll(async () => {
    const app = buildNewsIntelligenceApp({
      analyze: async () => [{ articleId: 'a-1', catalyst: 'ETF approval', importance: 9, relatedPairs: [], tags: [] }],
      listSignals: async () => [{ articleId: 'a-1', catalyst: 'ETF approval', importance: 9, relatedPairs: [], tags: [] }],
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

  it('returns signals from /news/signals', async () => {
    const response = await fetch(`${baseUrl}/news/signals`);
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-intelligence/app.test.ts`

**Step 3: Write minimal implementation**
```typescript
import express from 'express';

export function buildNewsIntelligenceApp(deps: {
  analyze: (body: any) => Promise<unknown[]>;
  listSignals: () => Promise<unknown[]>;
}) {
  const app = express();
  app.use(express.json());

  app.post('/news/analyze', async (req, res) => {
    res.json({ items: await deps.analyze(req.body.articles ?? []) });
  });

  app.get('/news/signals', async (_req, res) => {
    res.json({ items: await deps.listSignals() });
  });

  return app;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-intelligence/app.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-intelligence/app.test.ts src/platform/news-intelligence/app.ts src/platform/news-intelligence/http-server.ts
git commit -m "feat(m3): expose news intelligence http app #gemini"
```

