# M2 News Acquisition Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Build a standalone news acquisition platform that ingests raw articles from RSS and provider APIs, normalizes them, deduplicates them, and exposes them through a stable API.

**Architecture:** Create `src/platform/news-acquisition/` with canonical raw-article contracts, source adapters, an ingestion service, and an HTTP app. Reuse existing RSS and source-health code only as adapters so the trading bot no longer owns ingestion scheduling or article storage.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Raw Article Contracts

**Files:**
- Create: `src/platform/news-acquisition/contracts.ts`
- Test: `tests/platform/news-acquisition/contracts.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import {
  buildArticleIdentity,
  normalizeRawArticle,
} from '../../../src/platform/news-acquisition/contracts.js';

describe('platform/news-acquisition/contracts', () => {
  it('prefers url as the stable article identity', () => {
    expect(buildArticleIdentity({ title: 'A', url: 'https://a.test', source: 'rss' })).toBe('https://a.test');
  });

  it('falls back to source and title when url is missing', () => {
    expect(buildArticleIdentity({ title: 'A', source: 'rss' })).toBe('rss::A');
  });

  it('normalizes optional arrays to empty arrays', () => {
    const article = normalizeRawArticle({ title: 'A', source: 'rss' });
    expect(article.coins).toEqual([]);
    expect(article.topics).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-acquisition/contracts.test.ts`

**Step 3: Write minimal implementation**
```typescript
export interface RawArticle {
  title: string;
  source: string;
  url?: string;
  publishedAt?: string;
  excerpt?: string;
  coins?: string[];
  topics?: string[];
}

export function buildArticleIdentity(article: Pick<RawArticle, 'title' | 'source' | 'url'>): string {
  return article.url || `${article.source}::${article.title}`;
}

export function normalizeRawArticle(article: RawArticle): RawArticle {
  return {
    ...article,
    coins: article.coins ?? [],
    topics: article.topics ?? [],
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-acquisition/contracts.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-acquisition/contracts.test.ts src/platform/news-acquisition/contracts.ts
git commit -m "feat(m2): add raw article contracts #gemini"
```

### Task 2: Source Adapters

**Files:**
- Create: `src/platform/news-acquisition/source-adapter.ts`
- Create: `src/platform/news-acquisition/rss-adapter.ts`
- Modify: `src/news/rss-fetcher.ts`
- Test: `tests/platform/news-acquisition/rss-adapter.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { RssSourceAdapter } from '../../../src/platform/news-acquisition/rss-adapter.js';

describe('platform/news-acquisition/rss-adapter', () => {
  it('maps rss fetcher items to normalized raw articles', async () => {
    const fetcher = {
      fetchNews: vi.fn().mockResolvedValue([
        { title: 'ETF headline', source: 'CoinDesk', url: 'https://x.test', date: '2026-03-12T10:00:00Z' },
      ]),
    };

    const adapter = new RssSourceAdapter(fetcher as any);
    const items = await adapter.fetch();

    expect(items[0]).toMatchObject({
      title: 'ETF headline',
      source: 'CoinDesk',
      url: 'https://x.test',
      publishedAt: '2026-03-12T10:00:00Z',
    });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-acquisition/rss-adapter.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { normalizeRawArticle, type RawArticle } from './contracts.js';

export interface SourceAdapter {
  id: string;
  fetch(): Promise<RawArticle[]>;
}

export class RssSourceAdapter implements SourceAdapter {
  id = 'rss';

  constructor(private rssFetcher: { fetchNews(limit?: number): Promise<any[]> }) {}

  async fetch(): Promise<RawArticle[]> {
    const news = await this.rssFetcher.fetchNews();
    return news.map((item) =>
      normalizeRawArticle({
        title: item.title,
        source: item.source,
        url: item.url,
        publishedAt: item.date,
        excerpt: item.excerpt,
      }),
    );
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-acquisition/rss-adapter.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-acquisition/rss-adapter.test.ts src/platform/news-acquisition/source-adapter.ts src/platform/news-acquisition/rss-adapter.ts src/news/rss-fetcher.ts
git commit -m "feat(m2): add rss source adapter for acquisition platform #gemini"
```

### Task 3: Ingestion Service + Dedup Store

**Files:**
- Create: `src/platform/news-acquisition/article-store.ts`
- Create: `src/platform/news-acquisition/service.ts`
- Test: `tests/platform/news-acquisition/service.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { AcquisitionService } from '../../../src/platform/news-acquisition/service.js';

describe('platform/news-acquisition/service', () => {
  it('stores only unique articles across all adapters', async () => {
    const store = {
      upsertMany: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    const adapters = [
      { id: 'rss-a', fetch: vi.fn().mockResolvedValue([{ title: 'A', source: 'CoinDesk', url: 'https://x.test' }]) },
      { id: 'rss-b', fetch: vi.fn().mockResolvedValue([{ title: 'A', source: 'CoinDesk', url: 'https://x.test' }]) },
    ];

    const service = new AcquisitionService({ adapters: adapters as any, store });
    const result = await service.ingestAll();

    expect(result.inserted).toBe(1);
    expect(store.upsertMany).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-acquisition/service.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { buildArticleIdentity, normalizeRawArticle, type RawArticle } from './contracts.js';
import type { SourceAdapter } from './source-adapter.js';

interface ArticleStore {
  upsertMany(items: RawArticle[]): Promise<void>;
  list(limit?: number): Promise<RawArticle[]>;
}

export class AcquisitionService {
  constructor(private deps: { adapters: SourceAdapter[]; store: ArticleStore }) {}

  async ingestAll(): Promise<{ inserted: number }> {
    const batches = await Promise.all(this.deps.adapters.map((adapter) => adapter.fetch()));
    const unique = new Map<string, RawArticle>();

    for (const batch of batches) {
      for (const item of batch) {
        const normalized = normalizeRawArticle(item);
        unique.set(buildArticleIdentity(normalized), normalized);
      }
    }

    const values = [...unique.values()];
    await this.deps.store.upsertMany(values);
    return { inserted: values.length };
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-acquisition/service.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-acquisition/service.test.ts src/platform/news-acquisition/article-store.ts src/platform/news-acquisition/service.ts
git commit -m "feat(m2): add acquisition service and dedup store #gemini"
```

### Task 4: HTTP App

**Files:**
- Create: `src/platform/news-acquisition/app.ts`
- Create: `src/platform/news-acquisition/http-server.ts`
- Test: `tests/platform/news-acquisition/app.test.ts`

**Step 1: Write the failing test**
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNewsAcquisitionApp } from '../../../src/platform/news-acquisition/app.js';

describe('platform/news-acquisition/app', () => {
  let server: any;
  let baseUrl = '';

  beforeAll(async () => {
    const app = buildNewsAcquisitionApp({
      ingestAll: async () => ({ inserted: 2 }),
      listArticles: async () => [{ title: 'A', source: 'CoinDesk', coins: [], topics: [] }],
      health: () => ({ rss: 'ok' }),
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

  it('returns ingestion result', async () => {
    const response = await fetch(`${baseUrl}/ingest/rss`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inserted: 2 });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/news-acquisition/app.test.ts`

**Step 3: Write minimal implementation**
```typescript
import express from 'express';

export function buildNewsAcquisitionApp(deps: {
  ingestAll: () => Promise<{ inserted: number }>;
  listArticles: () => Promise<unknown[]>;
  health: () => Record<string, string>;
}) {
  const app = express();
  app.use(express.json());

  app.post('/ingest/rss', async (_req, res) => {
    res.json(await deps.ingestAll());
  });

  app.get('/articles', async (_req, res) => {
    res.json({ items: await deps.listArticles() });
  });

  app.get('/sources/health', (_req, res) => {
    res.json(deps.health());
  });

  return app;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/news-acquisition/app.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/news-acquisition/app.test.ts src/platform/news-acquisition/app.ts src/platform/news-acquisition/http-server.ts
git commit -m "feat(m2): expose news acquisition http app #gemini"
```

