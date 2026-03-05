# Max Info Fetch & Deduplication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Ensure the bot fetches maximum available information by using both RSS and CryptoPanic sources simultaneously, deduplicating the results to provide a clean "info pipe" to the LLM experts.

**Architecture:** Update `TradingLoop` news refresh logic to use `Promise.allSettled` across all configured fetchers. Implement a title-based deduplication utility to filter out identical news items across different sources.

**Tech Stack:** TypeScript, Node.js, Vitest.

---

### Task 1: Refactor News Fetching in TradingLoop

**Files:**
- Modify: `src/trading-loop.ts:247-260`

**Step 1: Write the failing test**
Create a test that injects both `rssFetcher` and `newsClient` and verifies both are called.
```typescript
// tests/news-parallel.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TradingLoop } from '../src/trading-loop.js';

describe('TradingLoop News info pipe', () => {
  it('fetches from both RSS and newsClient when both are available', async () => {
    const mockRss = { fetchNews: vi.fn().mockResolvedValue([{ title: 'A', source: 'RSS' }]) };
    const mockCP = { fetchNews: vi.fn().mockResolvedValue([{ title: 'B', source: 'CP' }]) };
    
    // ... setup TradingLoop with mocks ...
    // Verify results contain both A and B
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/news-parallel.test.ts`

**Step 3: Write minimal implementation**
Modify `src/trading-loop.ts` to fetch from both:
```typescript
      if (this.deps.newsCache.shouldRefresh(this.deps.newsConfig.refreshIntervalH)) {
        const fetchers = [];
        if (this.deps.rssFetcher) fetchers.push(this.deps.rssFetcher.fetchNews(this.deps.newsConfig.maxItems));
        if (this.deps.newsClient) fetchers.push(this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems));

        if (fetchers.length > 0) {
          console.log(`[News] Cache stale — fetching from ${fetchers.length} sources...`);
          const results = await Promise.allSettled(fetchers);
          const allItems: CryptoNews[] = [];
          
          for (const res of results) {
            if (res.status === 'fulfilled') allItems.push(...res.value);
          }
          
          // Deduplicate by title
          const seen = new Set<string>();
          const uniqueItems = allItems.filter(item => {
            const key = item.title.toLowerCase().trim().replace(/\s+/g, ' ');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          // Proceed with analyzed uniqueItems ...
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/news-parallel.test.ts`

**Step 5: Commit**
```bash
git add src/trading-loop.ts
git commit -m "feat: fetch news from all available sources in parallel #gemini"
```

### Task 2: Verify Info Pipe Integration

**Files:**
- Modify: `src/trading-loop.ts`

**Step 1: Write the failing test**
Verify that the `macroData` and `newsData` actually reach `runLayer1Experts`.

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/trading-loop.test.ts`

**Step 3: Write minimal implementation**
Ensure `this.lastMacroAnalysis` persists correctly between cycles and is passed to experts. (Double check current persists logic).

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/trading-loop.test.ts`

**Step 5: Commit**
```bash
git commit -m "chore: verify info pipe integration #gemini"
```
