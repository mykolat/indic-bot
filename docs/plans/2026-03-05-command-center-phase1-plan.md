# Command Center Phase 1: Multi-Source RSS + Grok Grounding — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace single-source CryptoPanic with direct RSS multi-source news + Grok xAI grounding for high-importance claims, with source health monitoring and cost tracking.

**Architecture:** New `RssNewsFetcher` fetches RSS XML directly from CoinDesk, CoinTelegraph, Decrypt (no Apify). `GrokGrounder` calls xAI API directly (`api.x.ai/v1/chat/completions`) to verify flagged claims. Grounding results are persisted in soul.md `## Verified Intelligence` section. A `NewsFetcher` interface decouples the trading loop from concrete news sources. `SourceHealthMonitor` tracks per-source uptime and Grok API cost.

**Tech Stack:** `fast-xml-parser` (RSS XML parsing), xAI API (Grok grounding), vitest, existing `fetchWithTimeout`

---

### Task 1: Install fast-xml-parser + create NewsFetcher interface

**Files:**
- Modify: `package.json` — add `fast-xml-parser`
- Create: `src/news/news-fetcher.ts` — shared interface
- Test: n/a (interface only)

**Step 1: Install fast-xml-parser**

Run: `npm install fast-xml-parser`
Expected: Added to `dependencies` in `package.json`

**Step 2: Create NewsFetcher interface**

```typescript
// src/news/news-fetcher.ts
import type { CryptoNews } from './types.js';

/**
 * Common interface for all news sources.
 * CryptoPanicClient, RssNewsFetcher, and future paid sources implement this.
 */
export interface NewsFetcher {
  fetchNews(limit?: number): Promise<CryptoNews[]>;
}
```

**Step 3: Make CryptoPanicClient implement NewsFetcher**

In `src/news/cryptopanic.ts`, add import and `implements`:

```typescript
import type { NewsFetcher } from './news-fetcher.js';
// ...
export class CryptoPanicClient implements NewsFetcher {
```

No other changes — it already satisfies the interface.

**Step 4: Update TradingLoopDeps to use NewsFetcher**

In `src/trading-loop.ts`, change line 28:

```typescript
// Before:
newsClient?: CryptoPanicClient;
// After:
newsClient?: import('./news/news-fetcher.js').NewsFetcher;
```

Remove the `CryptoPanicClient` import if it's no longer used elsewhere in trading-loop.ts.

**Step 5: Run tests to verify nothing breaks**

Run: `npx vitest run tests/`
Expected: All existing tests PASS

**Step 6: Commit**

```bash
git add package.json package-lock.json src/news/news-fetcher.ts src/news/cryptopanic.ts src/trading-loop.ts
git commit -m "refactor: extract NewsFetcher interface, install fast-xml-parser"
```

---

### Task 2: Create RssNewsFetcher

**Files:**
- Create: `src/news/rss-fetcher.ts`
- Test: `tests/news/rss-fetcher.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/news/rss-fetcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssNewsFetcher } from '../../src/news/rss-fetcher.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

const COINDESK_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Bitcoin hits new high</title>
      <link>https://coindesk.com/btc</link>
      <pubDate>Wed, 05 Mar 2026 10:00:00 +0000</pubDate>
      <description>BTC surges past 100k</description>
    </item>
  </channel>
</rss>`;

const COINTELEGRAPH_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>ETH DeFi boom</title>
      <link>https://cointelegraph.com/eth</link>
      <pubDate>Wed, 05 Mar 2026 09:00:00 +0000</pubDate>
      <description>Ethereum DeFi TVL up</description>
    </item>
  </channel>
</rss>`;

describe('RssNewsFetcher', () => {
  let fetcher: RssNewsFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new RssNewsFetcher();
  });

  it('fetches and merges articles from multiple RSS feeds', async () => {
    // CoinDesk succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => COINDESK_RSS,
    } as any);
    // CoinTelegraph succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => COINTELEGRAPH_RSS,
    } as any);
    // Decrypt fails
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const items = await fetcher.fetchNews(100);

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Bitcoin hits new high');
    expect(items[0].source).toBe('CoinDesk');
    expect(items[0].date).toBe('Wed, 05 Mar 2026 10:00:00 +0000');
    expect(items[0].coins).toEqual([]); // coins extracted by analyst
    expect(items[0].sentiment).toBe(0); // no vote data from RSS
    expect(items[1].source).toBe('CoinTelegraph');

    // All 3 feeds attempted
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns empty array when all feeds fail', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const items = await fetcher.fetchNews();
    expect(items).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const bigRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      ${Array.from({ length: 20 }, (_, i) => `<item><title>Article ${i}</title><link>https://x.com/${i}</link><pubDate>Wed, 05 Mar 2026 10:00:00 +0000</pubDate><description>desc</description></item>`).join('')}
    </channel></rss>`;

    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => bigRss } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews(5);
    expect(items).toHaveLength(5);
  });

  it('handles non-ok HTTP response gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews();
    expect(items).toEqual([]);
  });

  it('sorts articles by date (newest first)', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <item><title>Old</title><link>https://x.com/1</link><pubDate>Mon, 03 Mar 2026 10:00:00 +0000</pubDate><description>old</description></item>
      <item><title>New</title><link>https://x.com/2</link><pubDate>Wed, 05 Mar 2026 10:00:00 +0000</pubDate><description>new</description></item>
    </channel></rss>`;

    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => rss } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews();
    expect(items[0].title).toBe('New');
    expect(items[1].title).toBe('Old');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/news/rss-fetcher.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/news/rss-fetcher.ts
import { XMLParser } from 'fast-xml-parser';
import type { CryptoNews } from './types.js';
import type { NewsFetcher } from './news-fetcher.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

export interface RssFeedSource {
  name: string;
  url: string;
}

const DEFAULT_FEEDS: RssFeedSource[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const RSS_TIMEOUT_MS = 10_000;

export class RssNewsFetcher implements NewsFetcher {
  private parser = new XMLParser({ ignoreAttributes: true });

  constructor(private feeds: RssFeedSource[] = DEFAULT_FEEDS) {}

  async fetchNews(limit = 100): Promise<CryptoNews[]> {
    const results = await Promise.allSettled(
      this.feeds.map((feed) => this.fetchFeed(feed)),
    );

    const allItems: CryptoNews[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      }
    }

    // Sort newest first
    allItems.sort((a, b) => {
      const da = new Date(a.date).getTime() || 0;
      const db = new Date(b.date).getTime() || 0;
      return db - da;
    });

    return allItems.slice(0, limit);
  }

  private async fetchFeed(feed: RssFeedSource): Promise<CryptoNews[]> {
    try {
      const response = await fetchWithTimeout(
        feed.url,
        { method: 'GET' },
        RSS_TIMEOUT_MS,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xml = await response.text();
      const parsed = this.parser.parse(xml);
      const items = parsed?.rss?.channel?.item;
      if (!items) return [];

      const arr = Array.isArray(items) ? items : [items];

      return arr.map((item: any) => ({
        title: item.title || '',
        date: item.pubDate || '',
        coins: [],       // coins extracted by NewsAnalyst LLM
        sentiment: 0,    // no vote data from RSS
        source: feed.name,
      }));
    } catch (err) {
      console.error(`[RSS] ${feed.name} error:`, (err as Error).message);
      return [];
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/news/rss-fetcher.test.ts`
Expected: PASS — 5 tests

**Step 5: Commit**

```bash
git add src/news/rss-fetcher.ts tests/news/rss-fetcher.test.ts
git commit -m "feat: add RssNewsFetcher — direct RSS from CoinDesk, CoinTelegraph, Decrypt"
```

---

### Task 3: Create GrokGrounder (direct xAI API)

**Files:**
- Create: `src/news/grok-grounder.ts`
- Test: `tests/news/grok-grounder.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/news/grok-grounder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrokGrounder } from '../../src/news/grok-grounder.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

describe('GrokGrounder', () => {
  let grounder: GrokGrounder;

  beforeEach(() => {
    vi.clearAllMocks();
    grounder = new GrokGrounder('test-xai-key');
  });

  it('verifies a claim via xAI API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              verified: true,
              confidence: 0.95,
              summary: 'Confirmed by @SECGov and @Bloomberg.',
              sources: ['@SECGov', '@Bloomberg'],
              contradictions: [],
            }),
          },
        }],
        usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      }),
    } as any);

    const result = await grounder.verify('SEC approves spot BTC ETF');

    expect(result.claim).toBe('SEC approves spot BTC ETF');
    expect(result.verified).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.summary).toContain('Confirmed');
    expect(result.tokensUsed).toBe(300);

    // Verify xAI API call format
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe('grok-3');
    expect(opts!.headers).toHaveProperty('Authorization', 'Bearer test-xai-key');
  });

  it('returns unverified result on API failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const result = await grounder.verify('Some claim');

    expect(result.claim).toBe('Some claim');
    expect(result.verified).toBeUndefined();
    expect(result.error).toBe('timeout');
    expect(result.tokensUsed).toBe(0);
  });

  it('returns unverified on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as any);

    const result = await grounder.verify('Some claim');
    expect(result.error).toContain('401');
  });

  it('handles malformed JSON in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Not valid JSON at all' } }],
        usage: { total_tokens: 50 },
      }),
    } as any);

    const result = await grounder.verify('Claim');
    // Should still return something — summary from raw content
    expect(result.claim).toBe('Claim');
    expect(result.summary).toBeDefined();
    expect(result.tokensUsed).toBe(50);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/news/grok-grounder.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/news/grok-grounder.ts
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';

const GROUNDING_PROMPT = `You are a crypto news fact-checker with real-time X/Twitter access.
Given a claim about crypto markets, search X for verification.

Return ONLY valid JSON:
{
  "verified": true|false|null,
  "confidence": <0-1>,
  "summary": "1-2 sentences: what you found on X",
  "sources": ["@account1", "@account2"],
  "contradictions": ["any contradicting evidence"]
}

Rules:
- verified=true: multiple credible sources confirm
- verified=false: contradicted by official sources or clearly fake
- verified=null: insufficient data to determine
- confidence: 0=no data, 0.5=mixed signals, 1.0=certain
- sources: X accounts that discuss this claim`;

export interface GroundingResult {
  claim: string;
  verified?: boolean | null;
  confidence?: number;
  summary?: string;
  sources?: string[];
  contradictions?: string[];
  tokensUsed: number;
  error?: string;
}

export class GrokGrounder {
  constructor(private xaiApiKey: string) {}

  async verify(claim: string): Promise<GroundingResult> {
    try {
      const response = await fetchWithTimeout(
        XAI_API_URL,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.xaiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'grok-3',
            messages: [
              { role: 'system', content: GROUNDING_PROMPT },
              { role: 'user', content: `Verify this crypto claim using X/Twitter search:\n\n"${claim}"` },
            ],
            temperature: 0,
          }),
        },
        30_000,
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`xAI API ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = (await response.json()) as any;
      const content = data.choices?.[0]?.message?.content ?? '';
      const tokensUsed = data.usage?.total_tokens ?? 0;

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { claim, summary: content.slice(0, 300), tokensUsed };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        claim,
        verified: parsed.verified,
        confidence: parsed.confidence,
        summary: parsed.summary,
        sources: parsed.sources,
        contradictions: parsed.contradictions,
        tokensUsed,
      };
    } catch (err: any) {
      console.error('[GrokGrounder] Error:', err?.message);
      return { claim, error: err?.message, tokensUsed: 0 };
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/news/grok-grounder.test.ts`
Expected: PASS — 4 tests

**Step 5: Commit**

```bash
git add src/news/grok-grounder.ts tests/news/grok-grounder.test.ts
git commit -m "feat: add GrokGrounder — xAI direct API for claim verification"
```

---

### Task 4: Add source health monitor + cost tracker

**Files:**
- Create: `src/news/source-health.ts`
- Test: `tests/news/source-health.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/news/source-health.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SourceHealthMonitor } from '../../src/news/source-health.js';

describe('SourceHealthMonitor', () => {
  let monitor: SourceHealthMonitor;

  beforeEach(() => {
    monitor = new SourceHealthMonitor();
  });

  it('records success and failure for sources', () => {
    monitor.recordSuccess('CoinDesk');
    monitor.recordSuccess('CoinDesk');
    monitor.recordFailure('CoinDesk', 'timeout');

    const health = monitor.getHealth('CoinDesk');
    expect(health.totalAttempts).toBe(3);
    expect(health.successCount).toBe(2);
    expect(health.lastError).toBe('timeout');
  });

  it('tracks Grok API cost', () => {
    monitor.recordGrokUsage(300); // 300 tokens
    monitor.recordGrokUsage(500);

    const cost = monitor.getGrokCost();
    expect(cost.totalTokens).toBe(800);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.callCount).toBe(2);
  });

  it('returns summary of all sources', () => {
    monitor.recordSuccess('CoinDesk');
    monitor.recordFailure('Decrypt', 'HTTP 403');
    monitor.recordGrokUsage(100);

    const summary = monitor.getSummary();
    expect(summary).toContain('CoinDesk');
    expect(summary).toContain('Decrypt');
    expect(summary).toContain('Grok');
  });

  it('returns healthy status for unknown source', () => {
    const health = monitor.getHealth('Unknown');
    expect(health.totalAttempts).toBe(0);
    expect(health.successCount).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/news/source-health.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/news/source-health.ts

interface SourceStats {
  totalAttempts: number;
  successCount: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

interface GrokCostInfo {
  totalTokens: number;
  estimatedCostUsd: number;
  callCount: number;
}

// Grok-3 pricing: ~$3/M input, ~$15/M output tokens (approximate blended ~$5/M)
const GROK_COST_PER_TOKEN = 5 / 1_000_000;

export class SourceHealthMonitor {
  private sources = new Map<string, SourceStats>();
  private grokTokens = 0;
  private grokCalls = 0;

  recordSuccess(source: string): void {
    const s = this.getOrCreate(source);
    s.totalAttempts++;
    s.successCount++;
    s.lastSuccessAt = new Date().toISOString();
  }

  recordFailure(source: string, error: string): void {
    const s = this.getOrCreate(source);
    s.totalAttempts++;
    s.lastError = error;
    s.lastFailureAt = new Date().toISOString();
  }

  recordGrokUsage(tokensUsed: number): void {
    this.grokTokens += tokensUsed;
    this.grokCalls++;
  }

  getHealth(source: string): SourceStats {
    return this.sources.get(source) ?? { totalAttempts: 0, successCount: 0 };
  }

  getGrokCost(): GrokCostInfo {
    return {
      totalTokens: this.grokTokens,
      estimatedCostUsd: this.grokTokens * GROK_COST_PER_TOKEN,
      callCount: this.grokCalls,
    };
  }

  getSummary(): string {
    const lines: string[] = [];
    for (const [name, stats] of this.sources) {
      const rate = stats.totalAttempts > 0
        ? Math.round((stats.successCount / stats.totalAttempts) * 100)
        : 0;
      const err = stats.lastError ? ` (last error: ${stats.lastError})` : '';
      lines.push(`${name}: ${rate}% success (${stats.successCount}/${stats.totalAttempts})${err}`);
    }
    const grok = this.getGrokCost();
    if (grok.callCount > 0) {
      lines.push(`Grok: ${grok.callCount} calls, ${grok.totalTokens} tokens, ~$${grok.estimatedCostUsd.toFixed(4)}`);
    }
    return lines.join('\n');
  }

  private getOrCreate(source: string): SourceStats {
    if (!this.sources.has(source)) {
      this.sources.set(source, { totalAttempts: 0, successCount: 0 });
    }
    return this.sources.get(source)!;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/news/source-health.test.ts`
Expected: PASS — 4 tests

**Step 5: Commit**

```bash
git add src/news/source-health.ts tests/news/source-health.test.ts
git commit -m "feat: add SourceHealthMonitor — track source uptime + Grok API cost"
```

---

### Task 5: Add Verified Intelligence section to soul.md

**Files:**
- Modify: `src/memory/soul-keeper.ts` — add `verifiedIntel` section marker + `writeVerifiedIntel()` method
- Test: `tests/memory/soul-keeper-grounding.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/memory/soul-keeper-grounding.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SoulKeeper } from '../../src/memory/soul-keeper.js';
import { mkdirSync, rmSync, readFileSync } from 'fs';

const TEST_HOME = '/tmp/indic-soul-grounding-test';

describe('SoulKeeper — Verified Intelligence', () => {
  let keeper: SoulKeeper;

  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
    keeper = new SoulKeeper(`${TEST_HOME}/soul.md`);
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('writes verified intelligence entries', () => {
    keeper.writeVerifiedIntel([
      {
        claim: 'SEC approves spot BTC ETF',
        verified: true,
        confidence: 0.95,
        summary: 'Confirmed by @SECGov',
        timestamp: '2026-03-05T12:00:00Z',
      },
    ]);

    const content = readFileSync(`${TEST_HOME}/soul.md`, 'utf-8');
    expect(content).toContain('## Verified Intelligence');
    expect(content).toContain('SEC approves spot BTC ETF');
    expect(content).toContain('VERIFIED');
    expect(content).toContain('95%');
  });

  it('keeps only last 5 entries', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      claim: `Claim ${i}`,
      verified: true,
      confidence: 0.8,
      summary: `Summary ${i}`,
      timestamp: `2026-03-05T${String(i).padStart(2, '0')}:00:00Z`,
    }));
    keeper.writeVerifiedIntel(entries);

    const content = readFileSync(`${TEST_HOME}/soul.md`, 'utf-8');
    expect(content).not.toContain('Claim 0');
    expect(content).not.toContain('Claim 1');
    expect(content).toContain('Claim 6');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memory/soul-keeper-grounding.test.ts`
Expected: FAIL — `writeVerifiedIntel` is not a function

**Step 3: Add section marker and method to SoulKeeper**

In `src/memory/soul-keeper.ts`:

Add to `SECTION_MARKERS` (after `invisibleExits` line ~49):
```typescript
  verifiedIntel:  '## Verified Intelligence',
```

Add to `TEMPLATE` (before `## Performance Stats` line ~76):
```markdown

## Verified Intelligence

_No verified claims yet._

```

Add method to `SoulKeeper` class:
```typescript
  /** Write grounding results to Verified Intelligence section. Keep last 5. */
  writeVerifiedIntel(entries: Array<{
    claim: string;
    verified: boolean | null | undefined;
    confidence: number | undefined;
    summary: string | undefined;
    timestamp: string;
  }>): void {
    const last5 = entries.slice(-5);
    const lines = last5.map((e) => {
      const status = e.verified === true ? 'VERIFIED' : e.verified === false ? 'DEBUNKED' : 'UNCONFIRMED';
      const conf = e.confidence != null ? ` (${Math.round(e.confidence * 100)}%)` : '';
      return `- [${status}${conf}] ${e.claim} — ${e.summary ?? 'no details'} _(${e.timestamp})_`;
    });
    this.replaceSection('verifiedIntel', lines.join('\n'));
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/memory/soul-keeper-grounding.test.ts`
Expected: PASS — 2 tests

**Step 5: Run all soul-keeper tests**

Run: `npx vitest run tests/memory/`
Expected: All PASS (existing + new)

**Step 6: Commit**

```bash
git add src/memory/soul-keeper.ts tests/memory/soul-keeper-grounding.test.ts
git commit -m "feat: add Verified Intelligence section to soul.md"
```

---

### Task 6: Improve NewsAnalyst prompt + add needs_grounding

**Files:**
- Modify: `src/news/news-cache.ts` — add `needs_grounding` to `NewsSignal`
- Modify: `src/news/news-analyst.ts` — improve system prompt
- Test: `tests/news/news-analyst.test.ts` — add test for `needs_grounding`

**Step 1: Add `needs_grounding` to NewsSignal**

In `src/news/news-cache.ts`, add to `NewsSignal` interface (after `conflicting: boolean;`):

```typescript
  needs_grounding?: boolean;
```

**Step 2: Add test for needs_grounding**

Append to `tests/news/news-analyst.test.ts`:

```typescript
it('analyst output includes needs_grounding field', async () => {
  const mockLlm = {
    call: vi.fn().mockResolvedValue(JSON.stringify({
      market_summary: 'test',
      top_signals: [
        {
          coins: ['BTC'], direction: 'bullish', importance: 9,
          catalyst: 'SEC ETF approval', needs_grounding: true,
          timeframe: 'short', reasoning: 'big if true', price_impact: 'high',
          expires_hours: 24, source_count: 1, conflicting: false,
        },
      ],
      overall_sentiment: 'bullish',
      macro_signals: { fed_stance: 'neutral', risk_appetite: 'high', dominance_trend: 'stable' },
      risk_events: [],
    })),
  };
  const analyst = new NewsAnalystAgent(mockLlm as any);
  const result = await analyst.analyze([
    { title: 'SEC approves BTC ETF', date: '', coins: ['BTC'], sentiment: 5, source: 'unknown' },
  ]);
  expect(result.top_signals[0].needs_grounding).toBe(true);
});
```

**Step 3: Run test to verify it passes**

The test should pass immediately because the analyst just passes through the LLM JSON response — `needs_grounding` is already part of the parsed output.

Run: `npx vitest run tests/news/news-analyst.test.ts`
Expected: PASS

**Step 4: Update analyst system prompt**

In `src/news/news-analyst.ts`, update `ANALYST_SYSTEM_PROMPT`:

Add `"needs_grounding": false` to the JSON example inside the signal object.

Add these rules at the end of the rules section:
```
- needs_grounding: true if claim is extraordinary, from single source, could be fake, or has major market impact (importance >= 7 from single source)
- source_count: count how many DIFFERENT headlines/sources report the same event. Higher = more reliable.
- importance scale: 1-3 = background noise, 4-6 = notable, 7-8 = significant, 9-10 = market-moving (ETF approvals, major hacks, regulatory actions)
```

**Step 5: Run full news tests**

Run: `npx vitest run tests/news/`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/news/news-cache.ts src/news/news-analyst.ts tests/news/news-analyst.test.ts
git commit -m "feat: NewsAnalyst — add needs_grounding flag + improved importance rules"
```

---

### Task 7: Wire everything into TradingLoop + index.ts + config.yaml

**Files:**
- Modify: `src/trading-loop.ts` — add rssFetcher, grokGrounder, healthMonitor deps + grounding logic
- Modify: `src/index.ts` — instantiate new components
- Modify: `config.yaml` — add RSS + grounding config

**Step 1: Add new deps to TradingLoopDeps**

In `src/trading-loop.ts`, add to `TradingLoopDeps` interface (after `fallbackLlm?` line ~52):

```typescript
  rssFetcher?: import('./news/rss-fetcher.js').RssNewsFetcher;
  grokGrounder?: import('./news/grok-grounder.js').GrokGrounder;
  sourceHealth?: import('./news/source-health.js').SourceHealthMonitor;
  groundingConfig?: {
    minImportance: number;   // default 7
    maxPerCycle: number;     // default 2
  };
```

**Step 2: Update news refresh logic**

In `src/trading-loop.ts`, replace the news refresh block (lines 189-203) with:

```typescript
// 4. Refresh news cache if stale
if (this.deps.newsCache.shouldRefresh(this.deps.newsConfig.refreshIntervalH)) {
  console.log('[News] Cache stale — fetching fresh news...');

  // Primary: RSS feeds. Fallback: CryptoPanic
  const newsSource = this.deps.rssFetcher || this.deps.newsClient;
  if (newsSource) {
    const items = await newsSource.fetchNews(this.deps.newsConfig.maxItems);

    // Track source health
    if (this.deps.sourceHealth && this.deps.rssFetcher) {
      if (items.length > 0) {
        const sources = [...new Set(items.map(i => i.source))];
        for (const s of sources) this.deps.sourceHealth.recordSuccess(s);
      }
    }

    const analysis = await this.deps.newsAnalyst.analyze(items);

    // Grounding: verify high-importance claims via Grok
    if (this.deps.grokGrounder && analysis.top_signals?.length) {
      const cfg = this.deps.groundingConfig ?? { minImportance: 7, maxPerCycle: 2 };
      const toGround = analysis.top_signals
        .filter(s => s.needs_grounding && s.importance >= cfg.minImportance)
        .slice(0, cfg.maxPerCycle);

      const verifiedEntries: Array<any> = [];
      for (const signal of toGround) {
        const gResult = await this.deps.grokGrounder.verify(signal.catalyst);
        if (gResult.summary) {
          signal.reasoning += ` [Grok: ${gResult.summary.slice(0, 150)}]`;
        }
        if (this.deps.sourceHealth) {
          this.deps.sourceHealth.recordGrokUsage(gResult.tokensUsed);
        }
        verifiedEntries.push({
          claim: gResult.claim,
          verified: gResult.verified,
          confidence: gResult.confidence,
          summary: gResult.summary,
          timestamp: new Date().toISOString(),
        });
      }

      // Write to soul.md
      if (verifiedEntries.length > 0 && this.deps.soulKeeper) {
        this.deps.soulKeeper.writeVerifiedIntel(verifiedEntries);
      }
    }

    const cacheState = {
      items,
      fetchedAt: new Date().toISOString(),
      analysis,
      analyzedAt: new Date().toISOString(),
    };
    this.deps.newsCache.save(cacheState);
    this.deps.newsCache.appendHistory(cacheState);
  }
}
// Log source health summary periodically
if (this.deps.sourceHealth && this.cycleCount % 10 === 0) {
  console.log('[SourceHealth]\n' + this.deps.sourceHealth.getSummary());
}
const newsAnalysis = this.deps.newsCache.getAnalysis() ?? undefined;
```

**Step 3: Instantiate in index.ts**

In `src/index.ts`, add imports and instantiation after the existing newsClient block (after line ~106):

```typescript
import { RssNewsFetcher } from './news/rss-fetcher.js';
import { GrokGrounder } from './news/grok-grounder.js';
import { SourceHealthMonitor } from './news/source-health.js';

// RSS multi-source fetcher (always enabled — no API key needed)
const rssFetcher = new RssNewsFetcher();
console.log('[News] RSS multi-source fetcher enabled (CoinDesk, CoinTelegraph, Decrypt)');

// Grok grounding (optional — only if XAI_API_KEY set)
const grokGrounder = config.xaiApiKey
  ? new GrokGrounder(config.xaiApiKey)
  : undefined;
if (grokGrounder) console.log('[Grounding] Grok xAI enabled');
else console.log('[Grounding] No XAI_API_KEY — grounding disabled');

const sourceHealth = new SourceHealthMonitor();
```

Pass to TradingLoop constructor (add to deps object):

```typescript
  rssFetcher,
  grokGrounder,
  sourceHealth,
  groundingConfig: {
    minImportance: 7,
    maxPerCycle: 2,
  },
```

**Step 4: Update config.yaml with grounding config**

Append to `config.yaml`:

```yaml
grounding:
  minImportance: 7
  maxPerCycle: 2
```

**Step 5: Update config.ts to read grounding config from yaml**

In `src/config.ts`, add to `Config` interface:

```typescript
  grounding: {
    minImportance: number;
    maxPerCycle: number;
  };
```

In `loadConfig()`, add:

```typescript
  const g = y.grounding ?? {};
  // ... in the return object:
  grounding: {
    minImportance: g.minImportance ?? 7,
    maxPerCycle: g.maxPerCycle ?? 2,
  },
```

Update `src/index.ts` to use `config.grounding` instead of hardcoded values:

```typescript
  groundingConfig: config.grounding,
```

**Step 6: Run full test suite**

Run: `npx vitest run tests/`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/trading-loop.ts src/index.ts src/config.ts config.yaml
git commit -m "feat: wire RSS + Grok grounding + health monitor into trading loop"
```

---

### Task 8: Update FETCH_NEWS decision handler

**Files:**
- Modify: `src/trading-loop.ts` — update the `FETCH_NEWS` action handler to also use rssFetcher

**Step 1: Find FETCH_NEWS handler**

In `src/trading-loop.ts`, the `FETCH_NEWS` action handler (around lines 331-345) also calls `this.deps.newsClient.fetchNews()`. Update it to use the same `rssFetcher || newsClient` pattern.

Replace:
```typescript
if (this.deps.newsClient) {
  const items = await this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems);
```

With:
```typescript
const fetchNewsSource = this.deps.rssFetcher || this.deps.newsClient;
if (fetchNewsSource) {
  const items = await fetchNewsSource.fetchNews(this.deps.newsConfig.maxItems);
```

**Step 2: Run full test suite**

Run: `npx vitest run tests/`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat: FETCH_NEWS action uses RSS fetcher as primary source"
```

---

### Task 9: Expand soul.md token budget

**Files:**
- Modify: `src/llm/prompts.ts` or wherever soul.md content is truncated/limited
- Check soul.md integration in LLM prompt building

**Step 1: Find soul.md token limit**

Search for where soul.md content is truncated or limited. Check `src/llm/prompts.ts` for any `.slice()` or character limits applied to soul content.

Run: `grep -rn 'soul\|SOUL' src/llm/prompts.ts` to find all references.

**Step 2: Increase the limit**

If a character/line limit exists, double it (x2 minimum as user requested). If soul.md is included in full, verify the new "Verified Intelligence" section fits within the overall LLM context budget.

**Step 3: Run tests**

Run: `npx vitest run tests/`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: increase soul.md token budget x2 for Command Center"
```

---

### Summary

| Task | Component | New Files | Estimate |
|------|-----------|-----------|----------|
| 1 | NewsFetcher interface + fast-xml-parser | `src/news/news-fetcher.ts` | 5 min |
| 2 | RssNewsFetcher | `src/news/rss-fetcher.ts` + test | 15 min |
| 3 | GrokGrounder | `src/news/grok-grounder.ts` + test | 15 min |
| 4 | SourceHealthMonitor | `src/news/source-health.ts` + test | 10 min |
| 5 | Soul.md Verified Intelligence | modify soul-keeper + test | 10 min |
| 6 | NewsAnalyst improvements | modify prompt + test | 10 min |
| 7 | Wire into TradingLoop + config | modify loop + index + config | 15 min |
| 8 | FETCH_NEWS handler update | modify loop | 5 min |
| 9 | Soul.md token budget x2 | modify prompts | 5 min |
