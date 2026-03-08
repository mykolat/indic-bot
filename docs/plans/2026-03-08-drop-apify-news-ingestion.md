# Drop Apify — Crypto News Ingestion Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Apify-based news fetching with a self-hosted RSS ingestion layer that normalizes, deduplicates, and enriches news events for LLM consumption.

**Architecture:** Extend `RssNewsFetcher` to cover 15 curated sources across 4 taxonomy classes (newsroom, research, venue, protocol). Add a batch LLM enricher that tags `tickers`, `topics`, `priority` in one call per cycle. Add URL+fuzzy-title dedup. Replace `MacroFetcher` Apify polling with direct Yahoo Finance HTTP. Delete `cryptopanic.ts`.

**Tech Stack:** TypeScript ESM, `fast-xml-parser` (already installed), `fetchWithTimeout`, Vitest.

---

## Task 1: Extend `types.ts` — add `NewsEvent`

**Files:**
- Modify: `src/news/types.ts`

Add `NewsEvent` which extends `CryptoNews` with enrichment fields. Keep `CryptoNews` for backward-compat with `news-analyst.ts` until Task 5.

**Step 1: Write the failing test**

Create `tests/news/news-event.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { NewsEvent } from '../../src/news/types.js';

describe('NewsEvent type', () => {
  it('has required fields', () => {
    const e: NewsEvent = {
      title: 'SEC delays ETF',
      date: '2026-03-08T12:00:00Z',
      url: 'https://coindesk.com/sec-etf',
      source: 'CoinDesk',
      sourceType: 'newsroom',
      coins: [],
      sentiment: 0,
      tickers: ['ETH'],
      topics: ['ETF', 'Regulation'],
      priority: 0.86,
    };
    expect(e.sourceType).toBe('newsroom');
    expect(e.tickers).toEqual(['ETH']);
    expect(e.topics).toContain('ETF');
    expect(e.priority).toBeGreaterThan(0);
  });

  it('allows optional excerpt', () => {
    const e: NewsEvent = {
      title: 'BTC ATH', date: '', url: '', source: '', sourceType: 'newsroom',
      coins: [], sentiment: 0, tickers: [], topics: [], priority: 0,
      excerpt: 'Bitcoin set a new all-time high...',
    };
    expect(e.excerpt).toBeDefined();
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run tests/news/news-event.test.ts
```
Expected: FAIL — `NewsEvent` not exported from `types.ts`

**Step 3: Add `NewsEvent` to `src/news/types.ts`**

```ts
export type SourceType = 'newsroom' | 'research' | 'venue' | 'protocol';

export interface NewsEvent extends CryptoNews {
  url: string;
  sourceType: SourceType;
  tickers: string[];     // ['BTC', 'ETH'] — populated by enricher
  topics: string[];      // ['ETF', 'Regulation', 'Listing', 'Hack', ...]
  priority: number;      // 0–1, LLM-assigned
  excerpt?: string;
}
```

**Step 4: Run to verify it passes**

```bash
npx vitest run tests/news/news-event.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/news/types.ts tests/news/news-event.test.ts
git commit -m "feat(news): add NewsEvent type with sourceType, tickers, topics, priority"
```

---

## Task 2: Create `src/news/sources.ts` — 15 MVP sources

**Files:**
- Create: `src/news/sources.ts`
- Test: `tests/news/sources.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { NEWS_SOURCES, getSourceByName } from '../../src/news/sources.js';

describe('NEWS_SOURCES', () => {
  it('has at least 15 sources', () => {
    expect(NEWS_SOURCES.length).toBeGreaterThanOrEqual(15);
  });

  it('all sources have required fields', () => {
    for (const s of NEWS_SOURCES) {
      expect(s.name).toBeTruthy();
      expect(s.url).toMatch(/^https?:\/\//);
      expect(['newsroom', 'research', 'venue', 'protocol']).toContain(s.sourceType);
      expect(typeof s.priority).toBe('number');
    }
  });

  it('getSourceByName finds CoinDesk', () => {
    const s = getSourceByName('CoinDesk');
    expect(s?.sourceType).toBe('newsroom');
  });

  it('has at least one of each sourceType', () => {
    const types = new Set(NEWS_SOURCES.map(s => s.sourceType));
    expect(types).toContain('newsroom');
    expect(types).toContain('venue');
    expect(types).toContain('protocol');
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run tests/news/sources.test.ts
```
Expected: FAIL — module not found

**Step 3: Create `src/news/sources.ts`**

```ts
import type { SourceType } from './types.js';

export interface NewsSource {
  name: string;
  url: string;             // RSS feed URL
  sourceType: SourceType;
  priority: number;        // 1 (highest) → 3 (lower tier)
}

export const NEWS_SOURCES: NewsSource[] = [
  // Tier 1 — newsrooms
  { name: 'CoinDesk',      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', sourceType: 'newsroom', priority: 1 },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss',                   sourceType: 'newsroom', priority: 1 },
  { name: 'The Block',     url: 'https://www.theblock.co/rss.xml',                 sourceType: 'newsroom', priority: 1 },
  { name: 'Blockworks',    url: 'https://blockworks.co/feed',                      sourceType: 'newsroom', priority: 1 },
  { name: 'Decrypt',       url: 'https://decrypt.co/feed',                         sourceType: 'newsroom', priority: 1 },
  { name: 'DL News',       url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',   sourceType: 'newsroom', priority: 1 },
  { name: 'The Defiant',   url: 'https://thedefiant.io/feed',                      sourceType: 'newsroom', priority: 1 },
  // Tier 4 — official venues/issuers
  { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog/index.xml',          sourceType: 'venue',    priority: 1 },
  { name: 'Binance Blog',  url: 'https://www.binance.com/en/feed',                  sourceType: 'venue',    priority: 1 },
  { name: 'Kraken Blog',   url: 'https://blog.kraken.com/feed',                     sourceType: 'venue',    priority: 1 },
  { name: 'Circle Blog',   url: 'https://www.circle.com/blog/rss.xml',              sourceType: 'venue',    priority: 1 },
  { name: 'Tether News',   url: 'https://tether.to/en/feed/',                       sourceType: 'venue',    priority: 1 },
  // Tier 5 — official protocols
  { name: 'Uniswap Labs',          url: 'https://blog.uniswap.org/rss.xml',                sourceType: 'protocol', priority: 2 },
  { name: 'Ethereum Foundation',   url: 'https://blog.ethereum.org/en/feed.xml',           sourceType: 'protocol', priority: 2 },
  { name: 'Chainalysis Blog',      url: 'https://www.chainalysis.com/blog/feed.xml',        sourceType: 'research', priority: 2 },
];

export function getSourceByName(name: string): NewsSource | undefined {
  return NEWS_SOURCES.find(s => s.name === name);
}
```

**Step 4: Run to verify it passes**

```bash
npx vitest run tests/news/sources.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/news/sources.ts tests/news/sources.test.ts
git commit -m "feat(news): add 15-source NEWS_SOURCES registry with taxonomy"
```

---

## Task 3: Rewrite `src/news/rss-fetcher.ts` — 15 sources, `NewsEvent` output

**Files:**
- Modify: `src/news/rss-fetcher.ts`
- Modify: `tests/news/rss-fetcher.test.ts`

**Step 1: Update failing tests first**

Replace `tests/news/rss-fetcher.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssNewsFetcher } from '../../src/news/rss-fetcher.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));
vi.mock('../../src/db/repository.js', () => ({ insertNewsArticles: vi.fn().mockResolvedValue(undefined) }));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

const makeRss = (items: { title: string; link: string; pubDate: string; description?: string }[]) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
${items.map(i => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate><description>${i.description ?? ''}</description></item>`).join('\n')}
</channel></rss>`;

describe('RssNewsFetcher', () => {
  let fetcher: RssNewsFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use only 2 test sources to keep mock setup simple
    fetcher = new RssNewsFetcher([
      { name: 'CoinDesk', url: 'https://coindesk.com/rss', sourceType: 'newsroom', priority: 1 },
      { name: 'Binance Blog', url: 'https://binance.com/feed', sourceType: 'venue', priority: 1 },
    ]);
  });

  it('returns NewsEvent[] with url and sourceType', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => makeRss([
      { title: 'BTC ATH', link: 'https://coindesk.com/btc', pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000', description: 'Bitcoin hits 200k' },
    ]) } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews(10);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://coindesk.com/btc');
    expect(items[0].sourceType).toBe('newsroom');
    expect(items[0].tickers).toEqual([]);
    expect(items[0].topics).toEqual([]);
    expect(items[0].priority).toBe(0);
    expect(items[0].excerpt).toBe('Bitcoin hits 200k');
  });

  it('deduplicates by exact URL within one fetch', async () => {
    const dupRss = makeRss([
      { title: 'BTC news', link: 'https://coindesk.com/same', pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000' },
      { title: 'BTC news duplicate', link: 'https://coindesk.com/same', pubDate: 'Wed, 05 Mar 2026 10:01:00 +0000' },
    ]);
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => dupRss } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews(100);
    expect(items).toHaveLength(1);
  });

  it('returns empty array when all feeds fail', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const items = await fetcher.fetchNews();
    expect(items).toEqual([]);
  });

  it('sorts by date newest first', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => makeRss([
      { title: 'Old', link: 'https://coindesk.com/old', pubDate: 'Mon, 03 Mar 2026 10:00:00 +0000' },
      { title: 'New', link: 'https://coindesk.com/new', pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000' },
    ]) } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews();
    expect(items[0].title).toBe('New');
  });

  it('respects limit', async () => {
    const items20 = Array.from({ length: 20 }, (_, i) => ({
      title: `Article ${i}`, link: `https://coindesk.com/${i}`, pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000',
    }));
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => makeRss(items20) } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const result = await fetcher.fetchNews(5);
    expect(result).toHaveLength(5);
  });
});
```

**Step 2: Run to verify tests fail**

```bash
npx vitest run tests/news/rss-fetcher.test.ts
```
Expected: FAIL — `NewsEvent` fields missing, `sourceType` not set

**Step 3: Rewrite `src/news/rss-fetcher.ts`**

```ts
import { XMLParser } from 'fast-xml-parser';
import type { NewsEvent } from './types.js';
import type { NewsFetcher } from './news-fetcher.js';
import { NEWS_SOURCES, type NewsSource } from './sources.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { insertNewsArticles } from '../db/repository.js';

const RSS_TIMEOUT_MS = 10_000;

export class RssNewsFetcher implements NewsFetcher {
  private parser = new XMLParser({ ignoreAttributes: false });

  constructor(private feeds: NewsSource[] = NEWS_SOURCES) {}

  async fetchNews(limit = 100): Promise<NewsEvent[]> {
    const results = await Promise.allSettled(
      this.feeds.map(feed => this.fetchFeed(feed)),
    );

    const seenUrls = new Set<string>();
    const allItems: NewsEvent[] = [];

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value) {
        if (item.url && seenUrls.has(item.url)) continue;
        if (item.url) seenUrls.add(item.url);
        allItems.push(item);
      }
    }

    allItems.sort((a, b) => {
      const da = new Date(a.date).getTime() || 0;
      const db = new Date(b.date).getTime() || 0;
      return db - da;
    });

    const result = allItems.slice(0, limit);

    insertNewsArticles(result.map(a => ({
      title: a.title,
      source: a.source,
      coins: a.coins,
      sentiment: a.sentiment,
      published_at: a.date || undefined,
    }))).catch(() => {});

    return result;
  }

  private async fetchFeed(feed: NewsSource): Promise<NewsEvent[]> {
    try {
      const response = await fetchWithTimeout(feed.url, { method: 'GET' }, RSS_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const xml = await response.text();
      const parsed = this.parser.parse(xml);
      const items = parsed?.rss?.channel?.item;
      if (!items) return [];

      const arr = Array.isArray(items) ? items : [items];

      return arr.map((item: any): NewsEvent => ({
        title: String(item.title || ''),
        date: String(item.pubDate || ''),
        url: String(item.link || item.guid?.['#text'] || item.guid || ''),
        source: feed.name,
        sourceType: feed.sourceType,
        excerpt: item.description ? String(item.description).replace(/<[^>]*>/g, '').slice(0, 200) : undefined,
        coins: [],
        sentiment: 0,
        tickers: [],
        topics: [],
        priority: 0,
      }));
    } catch (err) {
      console.error(`[RSS] ${feed.name} error:`, (err as Error).message);
      return [];
    }
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/news/rss-fetcher.test.ts
```
Expected: PASS

**Step 5: Run all news tests to check for regressions**

```bash
npx vitest run tests/news/
```
Expected: all pass (news-analyst and others use `CryptoNews` which `NewsEvent` extends)

**Step 6: Commit**

```bash
git add src/news/rss-fetcher.ts tests/news/rss-fetcher.test.ts
git commit -m "feat(news): rewrite RssNewsFetcher — 15 sources, NewsEvent output, URL dedup"
```

---

## Task 4: Create `src/news/news-enricher.ts` — batch LLM tagger

**Files:**
- Create: `src/news/news-enricher.ts`
- Create: `tests/news/news-enricher.test.ts`

This module takes `NewsEvent[]` (unenriched), sends ONE LLM call, returns enriched events with `tickers`, `topics`, `priority`. If LLM fails → events pass through unchanged.

**Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { NewsEnricher } from '../../src/news/news-enricher.js';
import type { NewsEvent } from '../../src/news/types.js';

const makeEvent = (title: string, url = 'https://example.com/1'): NewsEvent => ({
  title, date: '', url, source: 'CoinDesk', sourceType: 'newsroom',
  coins: [], sentiment: 0, tickers: [], topics: [], priority: 0,
});

describe('NewsEnricher', () => {
  it('enriches events with tickers, topics, priority from LLM', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify([
        { tickers: ['ETH'], topics: ['ETF'], priority: 0.9 },
        { tickers: ['BTC'], topics: ['Regulation'], priority: 0.7 },
      ])),
    };
    const enricher = new NewsEnricher(mockLlm as any);
    const events = [makeEvent('SEC delays ETH ETF'), makeEvent('BTC regulations coming', 'https://example.com/2')];

    const result = await enricher.enrich(events);

    expect(result[0].tickers).toEqual(['ETH']);
    expect(result[0].topics).toEqual(['ETF']);
    expect(result[0].priority).toBe(0.9);
    expect(result[1].tickers).toEqual(['BTC']);
    expect(mockLlm.call).toHaveBeenCalledOnce();
  });

  it('returns original events if LLM fails', async () => {
    const mockLlm = { call: vi.fn().mockRejectedValue(new Error('timeout')) };
    const enricher = new NewsEnricher(mockLlm as any);
    const events = [makeEvent('Some news')];

    const result = await enricher.enrich(events);
    expect(result).toHaveLength(1);
    expect(result[0].tickers).toEqual([]);
    expect(result[0].priority).toBe(0);
  });

  it('returns original events if LLM returns invalid JSON', async () => {
    const mockLlm = { call: vi.fn().mockResolvedValue('not json at all') };
    const enricher = new NewsEnricher(mockLlm as any);
    const events = [makeEvent('Some news')];

    const result = await enricher.enrich(events);
    expect(result[0].tickers).toEqual([]);
  });

  it('handles empty input', async () => {
    const mockLlm = { call: vi.fn() };
    const enricher = new NewsEnricher(mockLlm as any);
    const result = await enricher.enrich([]);
    expect(result).toEqual([]);
    expect(mockLlm.call).not.toHaveBeenCalled();
  });

  it('caps batch at 50 events for LLM call', async () => {
    const events = Array.from({ length: 80 }, (_, i) => makeEvent(`News ${i}`, `https://x.com/${i}`));
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify(
        Array.from({ length: 50 }, () => ({ tickers: [], topics: [], priority: 0 }))
      )),
    };
    const enricher = new NewsEnricher(mockLlm as any);
    const result = await enricher.enrich(events);
    expect(result).toHaveLength(80); // all returned, 50 enriched + 30 passthrough
    expect(mockLlm.call).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run tests/news/news-enricher.test.ts
```
Expected: FAIL — module not found

**Step 3: Create `src/news/news-enricher.ts`**

```ts
import type { LLMClient } from '../llm/client.js';
import type { NewsEvent } from './types.js';

const ENRICH_BATCH = 50;

const SYSTEM_PROMPT = `You are a crypto news tagger. Given an array of news items, return ONLY a JSON array (no markdown) with one object per item in the same order.

Each object: { "tickers": string[], "topics": string[], "priority": number }

- tickers: crypto symbols mentioned or implied (["BTC", "ETH", "SOL", ...]). Empty [] if none.
- topics: from this list only: ETF, Regulation, Listing, Delisting, Hack, Exploit, Upgrade, Launch, Partnership, Macro, Stablecoin, Governance, Airdrop, Earnings, Other
- priority: 0.0–1.0 where 1.0 = market-moving (ETF approval, major hack, exchange collapse). 0.0 = opinion/recap.

Return exactly as many objects as input items, in the same order.`;

export class NewsEnricher {
  constructor(private llm: Pick<LLMClient, 'call'>) {}

  async enrich(events: NewsEvent[]): Promise<NewsEvent[]> {
    if (events.length === 0) return events;

    const batch = events.slice(0, ENRICH_BATCH);
    const passthrough = events.slice(ENRICH_BATCH);

    try {
      const input = batch.map((e, i) => `${i + 1}. [${e.source}/${e.sourceType}] ${e.title}`).join('\n');
      const raw = await this.llm.call(SYSTEM_PROMPT, `Tag these ${batch.length} news items:\n\n${input}`);

      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const tags = JSON.parse(jsonMatch[0]) as Array<{ tickers: string[]; topics: string[]; priority: number }>;

      const enriched = batch.map((e, i) => {
        const tag = tags[i];
        if (!tag) return e;
        return { ...e, tickers: tag.tickers ?? [], topics: tag.topics ?? [], priority: tag.priority ?? 0 };
      });

      console.log(`[NewsEnricher] Enriched ${enriched.length} events`);
      return [...enriched, ...passthrough];
    } catch (err) {
      console.error('[NewsEnricher] Failed, returning unenriched:', (err as Error).message);
      return events;
    }
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/news/news-enricher.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/news/news-enricher.ts tests/news/news-enricher.test.ts
git commit -m "feat(news): add NewsEnricher — batch LLM tagger for tickers/topics/priority"
```

---

## Task 5: Rewrite `src/news/macro-fetcher.ts` — drop Apify, use Yahoo Finance directly

**Files:**
- Modify: `src/news/macro-fetcher.ts`

Yahoo Finance provides data at `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d`. No API key required.

**Step 1: Write the failing test**

Create `tests/news/macro-fetcher-direct.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { MacroFetcher } from '../../src/news/macro-fetcher.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../src/db/repository.js', () => ({ insertMacroSnapshot: vi.fn().mockResolvedValue(undefined) }));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

const makeYahooResponse = (symbol: string, price: number, change: number) => ({
  ok: true,
  json: async () => ({
    chart: {
      result: [{
        meta: {
          symbol,
          regularMarketPrice: price,
          regularMarketChangePercent: change,
          regularMarketDayHigh: price * 1.01,
          regularMarketDayLow: price * 0.99,
        },
        timestamp: [1700000000, 1700086400, 1700172800, 1700259200, 1700345600],
        indicators: { quote: [{ close: [price * 0.97, price * 0.98, price * 0.99, price * 0.999, price] }] },
      }],
      error: null,
    },
  }),
} as any);

describe('MacroFetcher (direct Yahoo Finance)', () => {
  it('fetches all symbols without Apify', async () => {
    // 6 symbols + BTC dominance call
    mockFetch.mockResolvedValueOnce(makeYahooResponse('CL=F', 72.5, -0.3));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('DX-Y.NYB', 104.2, 0.1));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('^GSPC', 5800, 0.5));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('^VIX', 18.3, 2.1));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('EURUSD=X', 1.082, -0.05));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('GC=F', 2100, 0.2));

    const fetcher = new MacroFetcher();
    const result = await fetcher.fetch();

    expect(result).toHaveLength(6);
    expect(result[0].symbol).toBe('CL=F');
    expect(result[0].price).toBe(72.5);
    expect(result[0].change24h).toBeCloseTo(-0.3);
  });

  it('returns partial results on partial failure', async () => {
    mockFetch.mockResolvedValueOnce(makeYahooResponse('CL=F', 72.5, -0.3));
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    mockFetch.mockResolvedValueOnce(makeYahooResponse('^GSPC', 5800, 0.5));
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const fetcher = new MacroFetcher();
    const result = await fetcher.fetch();

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('constructor takes no arguments (no apifyToken)', () => {
    expect(() => new MacroFetcher()).not.toThrow();
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run tests/news/macro-fetcher-direct.test.ts
```
Expected: FAIL — constructor still requires `apifyToken`, Apify URLs used

**Step 3: Rewrite `src/news/macro-fetcher.ts`**

```ts
import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { insertMacroSnapshot } from '../db/repository.js';

export interface MacroSnapshot {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  changeWeek: number;
  dayHigh: number;
  dayLow: number;
}

const SYMBOLS = [
  { symbol: 'CL=F',      name: 'WTI Crude Oil' },
  { symbol: 'DX-Y.NYB',  name: 'DXY Dollar Index' },
  { symbol: '^GSPC',     name: 'S&P 500' },
  { symbol: '^VIX',      name: 'VIX Fear Index' },
  { symbol: 'EURUSD=X',  name: 'EUR/USD' },
  { symbol: 'GC=F',      name: 'Gold' },
];

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export class MacroFetcher {
  async fetch(): Promise<MacroSnapshot[]> {
    const results = await Promise.allSettled(
      SYMBOLS.map(s => this.fetchSymbol(s.symbol, s.name)),
    );

    const snapshots: MacroSnapshot[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) snapshots.push(r.value);
    }

    if (snapshots.length > 0) {
      const find = (sym: string) => snapshots.find(s => s.symbol === sym);
      insertMacroSnapshot({
        wti:    find('CL=F')?.price,
        dxy:    find('DX-Y.NYB')?.price,
        sp500:  find('^GSPC')?.price,
        vix:    find('^VIX')?.price,
        eurusd: find('EURUSD=X')?.price,
        gold:   find('GC=F')?.price,
      }).catch(() => {});
    }

    return snapshots;
  }

  private async fetchSymbol(symbol: string, name: string): Promise<MacroSnapshot | null> {
    try {
      const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const res = await fetchWithTimeout(url, {}, 10_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error('No result in Yahoo response');

      const meta = result.meta;
      const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
      const weekStart = closes.find((c: number | null) => c != null) ?? meta.regularMarketPrice;
      const weekChangeRaw = weekStart ? ((meta.regularMarketPrice - weekStart) / weekStart) * 100 : 0;

      return {
        symbol,
        name,
        price: parseFloat(meta.regularMarketPrice ?? 0),
        change24h: parseFloat(meta.regularMarketChangePercent ?? 0),
        changeWeek: parseFloat(weekChangeRaw.toFixed(2)),
        dayHigh: parseFloat(meta.regularMarketDayHigh ?? 0),
        dayLow: parseFloat(meta.regularMarketDayLow ?? 0),
      };
    } catch (err) {
      console.error(`[MacroFetcher] ${symbol} error:`, (err as Error).message);
      return null;
    }
  }

  async fetchBTCDominance(): Promise<{ dominance: number } | null> {
    try {
      const r = await fetchWithTimeout('https://api.coingecko.com/api/v3/global', {}, 10_000);
      if (!r.ok) return null;
      const data = await r.json() as any;
      return { dominance: data.data?.market_cap_percentage?.btc ?? 0 };
    } catch {
      return null;
    }
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/news/macro-fetcher-direct.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/news/macro-fetcher.ts tests/news/macro-fetcher-direct.test.ts
git commit -m "feat(news): replace MacroFetcher Apify with direct Yahoo Finance API"
```

---

## Task 6: Wire enricher into `src/index.ts`, remove Apify dependencies

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Delete: `src/news/cryptopanic.ts`

**Step 1: Update `src/index.ts`**

Find the news client section (around line 181–202) and replace:

```ts
// OLD — remove these:
import { CryptoPanicClient } from './news/cryptopanic.js';
import { MacroFetcher } from './news/macro-fetcher.js';

const newsClient = config.apifyToken
  ? new CryptoPanicClient(config.apifyToken)
  : undefined;
if (newsClient) console.log('[News] CryptoPanic via Apify enabled');
else console.log('[News] No APIFY_API_TOKEN — news disabled');

const macroFetcher = config.apifyToken ? new MacroFetcher(config.apifyToken) : undefined;
const macroAnalyst = macroFetcher ? new MacroAnalystAgent(llm) : undefined;
```

```ts
// NEW:
import { RssNewsFetcher } from './news/rss-fetcher.js';
import { NewsEnricher } from './news/news-enricher.js';
import { MacroFetcher } from './news/macro-fetcher.js';

const newsEnricher = new NewsEnricher(llm);
const newsClient = new RssNewsFetcher();
console.log('[News] RSS ingestion enabled — 15 sources');

const macroFetcher = new MacroFetcher();
const macroAnalyst = new MacroAnalystAgent(llm);
console.log('[Macro] Direct Yahoo Finance macro fetcher enabled');
```

Also remove the Apify-conditional log block around line 199–201.

**Step 2: Update `src/config.ts`**

Remove `apifyToken` from the `Config` interface and from `loadConfig()`:

```ts
// Remove this line from Config interface:
apifyToken: string | undefined;

// Remove this line from loadConfig():
apifyToken: process.env.APIFY_API_TOKEN,
```

**Step 3: Delete `src/news/cryptopanic.ts`**

```bash
rm src/news/cryptopanic.ts
```

**Step 4: Update `src/news/news-fetcher.ts` comment**

Change the JSDoc comment that mentions `CryptoPanicClient`:

```ts
/**
 * Common interface for all news sources.
 * RssNewsFetcher and future paid sources implement this.
 */
export interface NewsFetcher {
  fetchNews(limit?: number): Promise<NewsEvent[]>;
}
```

Also update the import in `news-fetcher.ts` to use `NewsEvent` instead of `CryptoNews`.

**Step 5: Run full test suite**

```bash
npx vitest run tests/
```
Expected: all pass. Fix any TypeScript compile errors from removed `apifyToken`.

**Step 6: Commit**

```bash
git add src/index.ts src/config.ts src/news/news-fetcher.ts
git rm src/news/cryptopanic.ts
git commit -m "feat(news): wire RssNewsFetcher+NewsEnricher, drop CryptoPanicClient and apifyToken"
```

---

## Task 7: Connect enricher in the trading loop news refresh cycle

**Files:**
- Modify: `src/trading-loop.ts`

Find where `newsClient.fetchNews()` is called. After the fetch, pipe through enricher.

**Step 1: Find the news fetch call**

```bash
grep -n "fetchNews\|newsClient" src/trading-loop.ts
```

**Step 2: Inject enricher**

In `TradingLoop` constructor and the relevant section, add:

```ts
// In TradingLoop options/constructor (wherever newsClient is wired):
private newsEnricher?: NewsEnricher;

// In the news refresh block, after fetchNews():
let newsItems = await this.newsClient.fetchNews(80);
if (this.newsEnricher) {
  newsItems = await this.newsEnricher.enrich(newsItems);
}
```

Pass `newsEnricher` from `src/index.ts` into `TradingLoop`.

**Step 3: Run full test suite**

```bash
npx vitest run tests/
```
Expected: all pass

**Step 4: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat(news): pipe NewsEnricher into TradingLoop news refresh"
```

---

## Task 8: Smoke test on VM + cleanup `.env`

**Step 1: Deploy to VM**

```bash
npm run deploy
```

**Step 2: SSH into VM and verify boot**

```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213
pm2 restart indic-bot
pm2 logs indic-bot --lines 50
```

Expected log lines:
```
[News] RSS ingestion enabled — 15 sources
[Macro] Direct Yahoo Finance macro fetcher enabled
```
No lines mentioning `Apify`, `CryptoPanic`, or `APIFY_API_TOKEN`.

**Step 3: Remove `APIFY_API_TOKEN` from `.env` on VM**

```bash
# On VM:
nano ~/indic-bot/.env
# Remove the APIFY_API_TOKEN line, save
pm2 restart indic-bot
pm2 logs indic-bot --lines 30
```

**Step 4: Verify one full cycle completes with news**

Wait for one trading cycle (up to 30 min if no positions). Check logs for:
```
[RSS] Fetched N articles from ...
[NewsEnricher] Enriched N events
[NewsAnalyst] Analyzing N headlines...
```

**Step 5: Final commit if any minor fixes needed**

```bash
git add -A
git commit -m "chore: smoke test fixes after Apify removal"
```

---

## Summary of Changes

| File | Action |
|------|--------|
| `src/news/types.ts` | Add `NewsEvent`, `SourceType` |
| `src/news/sources.ts` | Create — 15 source registry |
| `src/news/rss-fetcher.ts` | Rewrite — 15 sources, `NewsEvent` output, URL dedup |
| `src/news/news-enricher.ts` | Create — batch LLM tagger |
| `src/news/macro-fetcher.ts` | Rewrite — direct Yahoo Finance, no constructor args |
| `src/news/news-fetcher.ts` | Update interface to `NewsEvent` |
| `src/news/cryptopanic.ts` | **Delete** |
| `src/index.ts` | Wire new classes, remove Apify conditionals |
| `src/config.ts` | Remove `apifyToken` |
| `src/trading-loop.ts` | Inject `NewsEnricher` |
