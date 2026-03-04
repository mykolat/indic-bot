# News Cache + Analyst Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-cycle Apify calls (1440x/day) with a 2x/day cached news system + a separate Codex analyst agent that converts 100 raw headlines into structured JSON signals.

**Architecture:** NewsCache persists to `~/.indic-bot/news-cache.json`. NewsAnalystAgent calls Codex with a classification prompt and stores structured NewsAnalysis. Trading loop reads from cache each cycle; raw Apify is only called when cache is stale or LLM requests `FETCH_NEWS`. LLMClient gets a new `call()` method for generic string-in/string-out Codex calls.

**Tech Stack:** TypeScript, Node.js fs, existing Codex API via LLMClient

---

## Context

Design doc: `docs/plans/2026-03-04-news-cache-analyst-design.md`

Key existing files:
- `src/news/cryptopanic.ts` — Apify actor caller, currently slices to 10
- `src/llm/client.ts` — LLMClient with `analyze()`, needs new `call()` method
- `src/risk/manager.ts` — TradeDecision interface, needs `FETCH_NEWS` action
- `src/trading-loop.ts` — currently calls newsClient.fetchNews() every cycle
- `src/llm/prompts.ts` — EnrichedPromptData needs newsAnalysis field

Run tests: `npx vitest run tests/`
TypeScript check: `npx tsc --noEmit`

---

### Task 1: `src/news/news-cache.ts` — interfaces + NewsCache class

**Files:**
- Create: `src/news/news-cache.ts`
- Create: `tests/news/news-cache.test.ts`

**Step 1: Write failing tests**

Create `tests/news/news-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { NewsCache, type NewsCacheState } from '../../src/news/news-cache.js';

const TEST_HOME = '/tmp/indic-bot-test-news';

beforeEach(() => {
  mkdirSync(join(TEST_HOME, '.indic-bot'), { recursive: true });
  vi.stubEnv('HOME', TEST_HOME);
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const makeState = (hoursAgo: number): NewsCacheState => ({
  items: [{ title: 'Test', date: '2026-03-04', coins: ['BTC'], sentiment: 1, source: 'test' }],
  fetchedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  analysis: {
    market_summary: 'BTC bullish',
    top_signals: [],
    overall_sentiment: 'bullish',
    macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
    risk_events: [],
  },
  analyzedAt: new Date().toISOString(),
});

describe('NewsCache', () => {
  it('returns null when no cache file exists', () => {
    const cache = new NewsCache();
    expect(cache.load()).toBeNull();
  });

  it('saves and loads state', () => {
    const cache = new NewsCache();
    const state = makeState(1);
    cache.save(state);
    const loaded = cache.load();
    expect(loaded?.analysis?.market_summary).toBe('BTC bullish');
    expect(loaded?.items).toHaveLength(1);
  });

  it('shouldRefresh returns true when no cache', () => {
    const cache = new NewsCache();
    expect(cache.shouldRefresh(12)).toBe(true);
  });

  it('shouldRefresh returns false when cache is fresh', () => {
    const cache = new NewsCache();
    cache.save(makeState(1)); // 1 hour ago
    expect(cache.shouldRefresh(12)).toBe(false);
  });

  it('shouldRefresh returns true when cache is stale', () => {
    const cache = new NewsCache();
    cache.save(makeState(13)); // 13 hours ago
    expect(cache.shouldRefresh(12)).toBe(true);
  });

  it('getAnalysis returns null when no cache', () => {
    const cache = new NewsCache();
    expect(cache.getAnalysis()).toBeNull();
  });

  it('getAnalysis returns analysis from saved state', () => {
    const cache = new NewsCache();
    cache.save(makeState(1));
    const analysis = cache.getAnalysis();
    expect(analysis?.overall_sentiment).toBe('bullish');
  });

  it('appendHistory creates history file', () => {
    const cache = new NewsCache();
    const state = makeState(0);
    cache.appendHistory(state);
    const historyPath = join(TEST_HOME, '.indic-bot', 'news-history.jsonl');
    expect(existsSync(historyPath)).toBe(true);
    const line = JSON.parse(readFileSync(historyPath, 'utf-8').trim());
    expect(line.itemCount).toBe(1);
    expect(line.analysis.market_summary).toBe('BTC bullish');
  });

  it('appendHistory appends without overwriting', () => {
    const cache = new NewsCache();
    cache.appendHistory(makeState(2));
    cache.appendHistory(makeState(1));
    const historyPath = join(TEST_HOME, '.indic-bot', 'news-history.jsonl');
    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
```

**Step 2: Run to verify failure**

```bash
npx vitest run tests/news/news-cache.test.ts
```
Expected: FAIL — "Cannot find module '../../src/news/news-cache.js'"

**Step 3: Implement `src/news/news-cache.ts`**

```typescript
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { CryptoNews } from './types.js';

export interface NewsSignal {
  coins: string[];
  direction: 'bullish' | 'bearish' | 'neutral';
  importance: number;
  timeframe: 'short' | 'medium' | 'long';
  catalyst: string;
  reasoning: string;
  price_impact: 'high' | 'medium' | 'low';
  expires_hours: number;
  source_count: number;
  conflicting: boolean;
}

export interface NewsAnalysis {
  market_summary: string;
  top_signals: NewsSignal[];
  overall_sentiment: string;
  macro_signals: {
    fed_stance: string;
    risk_appetite: string;
    dominance_trend: string;
  };
  risk_events: string[];
}

export interface NewsCacheState {
  items: CryptoNews[];
  fetchedAt: string;
  analysis: NewsAnalysis | null;
  analyzedAt: string | null;
}

export class NewsCache {
  private get dir() { return join(process.env.HOME || '.', '.indic-bot'); }
  private get cacheFile() { return join(this.dir, 'news-cache.json'); }
  private get historyFile() { return join(this.dir, 'news-history.jsonl'); }

  load(): NewsCacheState | null {
    try {
      return JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as NewsCacheState;
    } catch {
      return null;
    }
  }

  save(state: NewsCacheState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.cacheFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  shouldRefresh(intervalHours: number): boolean {
    const state = this.load();
    if (!state) return true;
    const ageMs = Date.now() - new Date(state.fetchedAt).getTime();
    return ageMs > intervalHours * 3_600_000;
  }

  getAnalysis(): NewsAnalysis | null {
    return this.load()?.analysis ?? null;
  }

  appendHistory(state: NewsCacheState): void {
    mkdirSync(this.dir, { recursive: true });
    const record = {
      fetchedAt: state.fetchedAt,
      analyzedAt: state.analyzedAt,
      itemCount: state.items.length,
      analysis: state.analysis,
      items: state.items,
    };
    appendFileSync(this.historyFile, JSON.stringify(record) + '\n', 'utf-8');
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/news/news-cache.test.ts
```
Expected: all 9 pass

**Step 5: Commit**

```bash
git add src/news/news-cache.ts tests/news/news-cache.test.ts
git commit -m "feat: add NewsCache with load/save/shouldRefresh/appendHistory"
```

---

### Task 2: `src/llm/client.ts` — add generic `call()` method

**Files:**
- Modify: `src/llm/client.ts` (after `updateAccessToken` method, before closing `}`)

The NewsAnalystAgent needs to make a raw Codex call with a custom system prompt and get back a string. Add a public `call()` method that reuses the existing `streamSSE` logic.

**Step 1: No separate test needed** — covered by NewsAnalystAgent test (Task 3). TypeScript check suffices.

**Step 2: Add method to `src/llm/client.ts`**

After the `updateAccessToken` method (line 220), before the closing `}` of the class:

```typescript
  async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const body = {
      model: this.model,
      store: false,
      stream: true,
      instructions: systemPrompt,
      input: [{ role: 'user', content: userPrompt }],
      text: { verbosity: 'medium' },
    };

    const response = await fetch(CODEX_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'chatgpt-account-id': this.accountId,
        'OpenAI-Beta': 'responses=experimental',
        'User-Agent': `indic-bot (${os.platform()} ${os.release()}; ${os.arch()})`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Codex API ${response.status}: ${errText.slice(0, 300)}`);
    }

    return this.streamSSE(response);
  }
```

Note: `streamSSE` must be changed from `private` to `protected` or the call() method must be in the same class — it already is, so `private` is fine since `call()` is in the same class.

**Step 3: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 4: Commit**

```bash
git add src/llm/client.ts
git commit -m "feat: add LLMClient.call() for generic Codex prompts"
```

---

### Task 3: `src/news/news-analyst.ts` — NewsAnalystAgent

**Files:**
- Create: `src/news/news-analyst.ts`
- Create: `tests/news/news-analyst.test.ts`

**Step 1: Write failing test**

Create `tests/news/news-analyst.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NewsAnalystAgent } from '../../src/news/news-analyst.js';
import type { CryptoNews } from '../../src/news/types.js';

const mockNews: CryptoNews[] = [
  { title: 'Bitcoin ETF sees record $8B inflows', date: '2026-03-04', coins: ['BTC'], sentiment: 5, source: 'Bloomberg' },
  { title: 'Fed signals rate hold in March', date: '2026-03-04', coins: [], sentiment: -1, source: 'Reuters' },
];

describe('NewsAnalystAgent', () => {
  it('returns structured NewsAnalysis from LLM response', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        market_summary: 'BTC bullish on ETF flows',
        top_signals: [
          {
            coins: ['BTC'], direction: 'bullish', importance: 9,
            timeframe: 'short', catalyst: 'ETF inflows', reasoning: 'Demand surge',
            price_impact: 'high', expires_hours: 48, source_count: 3, conflicting: false,
          },
        ],
        overall_sentiment: 'bullish',
        macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'btc_gaining' },
        risk_events: ['FOMC tomorrow'],
      })),
    };

    const agent = new NewsAnalystAgent(mockLlm as any);
    const result = await agent.analyze(mockNews);

    expect(mockLlm.call).toHaveBeenCalledTimes(1);
    expect(result.market_summary).toBe('BTC bullish on ETF flows');
    expect(result.top_signals).toHaveLength(1);
    expect(result.top_signals[0].importance).toBe(9);
    expect(result.overall_sentiment).toBe('bullish');
    expect(result.macro_signals.fed_stance).toBe('neutral');
    expect(result.risk_events).toContain('FOMC tomorrow');
  });

  it('returns fallback on LLM parse error', async () => {
    const mockLlm = { call: vi.fn().mockResolvedValue('not valid json') };
    const agent = new NewsAnalystAgent(mockLlm as any);
    const result = await agent.analyze(mockNews);

    expect(result.market_summary).toContain('unavailable');
    expect(result.top_signals).toHaveLength(0);
  });

  it('returns fallback on LLM call failure', async () => {
    const mockLlm = { call: vi.fn().mockRejectedValue(new Error('API down')) };
    const agent = new NewsAnalystAgent(mockLlm as any);
    const result = await agent.analyze(mockNews);

    expect(result.top_signals).toHaveLength(0);
  });
});
```

**Step 2: Run to verify failure**

```bash
npx vitest run tests/news/news-analyst.test.ts
```
Expected: FAIL — "Cannot find module"

**Step 3: Implement `src/news/news-analyst.ts`**

```typescript
import type { LLMClient } from '../llm/client.js';
import type { CryptoNews } from './types.js';
import type { NewsAnalysis } from './news-cache.js';

const ANALYST_SYSTEM_PROMPT = `You are a crypto news analyst. Given a list of headlines, return ONLY valid JSON (no markdown, no explanation).

Analyze sentiment, importance, and directional signals for coins mentioned.

Return exactly this structure:
{
  "market_summary": "2-3 sentence narrative of current market conditions",
  "top_signals": [
    {
      "coins": ["BTC"],
      "direction": "bullish",
      "importance": 9,
      "timeframe": "short",
      "catalyst": "one-line trigger",
      "reasoning": "brief analysis",
      "price_impact": "high",
      "expires_hours": 48,
      "source_count": 3,
      "conflicting": false
    }
  ],
  "overall_sentiment": "bullish|bearish|neutral|cautiously_bullish|cautiously_bearish",
  "macro_signals": {
    "fed_stance": "hawkish|dovish|neutral",
    "risk_appetite": "high|moderate|low",
    "dominance_trend": "btc_gaining|altcoin_season|stable"
  },
  "risk_events": ["event1", "event2"]
}

Rules:
- importance 1-10 (10 = market moving)
- Only include signals with importance >= 4
- expires_hours: how long this news stays relevant (6-168)
- conflicting: true if multiple sources disagree on direction
- timeframe: short (<24h), medium (1-7d), long (>7d)`;

const FALLBACK: NewsAnalysis = {
  market_summary: 'News analysis unavailable',
  top_signals: [],
  overall_sentiment: 'neutral',
  macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
  risk_events: [],
};

export class NewsAnalystAgent {
  constructor(private llm: Pick<LLMClient, 'call'>) {}

  async analyze(items: CryptoNews[]): Promise<NewsAnalysis> {
    try {
      const headlines = items
        .map((n, i) => `${i + 1}. [${n.coins.join(',')||'GENERAL'}] ${n.title} (${n.source}, sentiment:${n.sentiment})`)
        .join('\n');

      const userPrompt = `Analyze these ${items.length} crypto headlines:\n\n${headlines}`;

      console.log(`[NewsAnalyst] Analyzing ${items.length} headlines...`);
      const raw = await this.llm.call(ANALYST_SYSTEM_PROMPT, userPrompt);

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return FALLBACK;

      const parsed = JSON.parse(jsonMatch[0]) as NewsAnalysis;
      console.log(`[NewsAnalyst] Done — ${parsed.top_signals?.length ?? 0} signals, sentiment: ${parsed.overall_sentiment}`);
      return parsed;
    } catch (err) {
      console.error('[NewsAnalyst] Error:', err);
      return FALLBACK;
    }
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/news/news-analyst.test.ts
```
Expected: all 3 pass

**Step 5: Commit**

```bash
git add src/news/news-analyst.ts tests/news/news-analyst.test.ts
git commit -m "feat: add NewsAnalystAgent — classifies headlines into structured signals"
```

---

### Task 4: Config + CryptoPanicClient limit

**Files:**
- Modify: `src/config.ts`
- Modify: `src/news/cryptopanic.ts`

**Step 1: No test needed** — config is tested indirectly.

**Step 2: Update `src/config.ts`**

In the `Config` interface, add to `trading`:
```typescript
    newsRefreshIntervalH: number;
    newsMaxItems: number;
```

In `loadConfig()`, add to `trading`:
```typescript
      newsRefreshIntervalH: parseInt(process.env.NEWS_REFRESH_INTERVAL_H || '12', 10),
      newsMaxItems: parseInt(process.env.NEWS_MAX_ITEMS || '100', 10),
```

**Step 3: Update `src/news/cryptopanic.ts`**

Change `fetchNews()` signature to accept limit:

```typescript
  async fetchNews(limit = 100): Promise<CryptoNews[]> {
```

Change the slice:
```typescript
      return items.slice(0, limit).map(...)
```

**Step 4: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: errors in files that pass news to trading loop (not yet updated) — fine for now.

**Step 5: Commit**

```bash
git add src/config.ts src/news/cryptopanic.ts
git commit -m "feat: add news config params and configurable limit to CryptoPanicClient"
```

---

### Task 5: `src/risk/manager.ts` — add FETCH_NEWS action

**Files:**
- Modify: `src/risk/manager.ts` (line 3: TradeDecision interface)

**Step 1: No new test** — existing tests cover HOLD/CLOSE passthrough; FETCH_NEWS follows same pattern.

**Step 2: Update `TradeDecision` in `src/risk/manager.ts`**

```typescript
export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
}
```

Also update `validate()` to pass through FETCH_NEWS (add to the early return check):

```typescript
  validate(decision: TradeDecision, portfolio: PortfolioState, riskState?: RiskState): ValidationResult {
    if (decision.action === 'HOLD' || decision.action === 'CLOSE' || decision.action === 'FETCH_NEWS') {
      return { approved: true };
    }
    // ... rest unchanged
```

**Step 3: Update system prompt in `src/llm/prompts.ts`**

At the end of `buildSystemPrompt()`, add to the constraints section before the closing template literal:

```typescript
  // After "Always include a decision for every pair..." line, add:
  '\n\nIf you need fresher news data, add one extra decision: { "pair": "_meta", "action": "FETCH_NEWS", "size_pct": 0, "leverage": 0, "stop_loss_pct": 0, "take_profit_pct": 0, "reasoning": "<why you need fresh news>" }'
```

**Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

**Step 5: Run tests**

```bash
npx vitest run tests/risk/
```
Expected: all pass

**Step 6: Commit**

```bash
git add src/risk/manager.ts src/llm/prompts.ts
git commit -m "feat: add FETCH_NEWS action type and system prompt instruction"
```

---

### Task 6: `src/llm/prompts.ts` — add newsAnalysis to EnrichedPromptData

**Files:**
- Modify: `src/llm/prompts.ts`

**Step 1: No new test** — prompt output is text; TypeScript check + visual inspection.

**Step 2: Update `EnrichedPromptData` interface**

Add after `recentTrades?`:
```typescript
  newsAnalysis?: import('../news/news-cache.js').NewsAnalysis;
```

**Step 3: Update `buildEnrichedPrompt()` news section**

Replace the current news block (lines ~131-139):
```typescript
  // News
  if (data.newsAnalysis) {
    const na = data.newsAnalysis;
    prompt += '## News Analysis\n';
    prompt += `Sentiment: ${na.overall_sentiment} | Macro: fed=${na.macro_signals.fed_stance}, risk=${na.macro_signals.risk_appetite}\n`;
    prompt += `Summary: ${na.market_summary}\n`;
    if (na.top_signals.length > 0) {
      prompt += 'Signals:\n';
      for (const s of na.top_signals.sort((a, b) => b.importance - a.importance).slice(0, 8)) {
        const coins = s.coins.join('/');
        prompt += `  [${s.importance}/10] ${coins} ${s.direction.toUpperCase()} (${s.timeframe}) — ${s.catalyst}${s.conflicting ? ' ⚡conflicting' : ''}\n`;
      }
    }
    if (na.risk_events.length > 0) {
      prompt += `Risk events: ${na.risk_events.join(', ')}\n`;
    }
    prompt += '\n';
  } else if (data.news.length > 0) {
    // Fallback to raw headlines if no analysis yet
    prompt += '## Recent News\n';
    for (const n of data.news) {
      const sentimentStr = n.sentiment > 0 ? `+${n.sentiment}` : `${n.sentiment}`;
      const coins = n.coins.length > 0 ? ` (${n.coins.join(', ')})` : '';
      prompt += `- [${sentimentStr}] "${n.title}"${coins} — ${n.date} via ${n.source}\n`;
    }
    prompt += '\n';
  }
```

**Step 4: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 5: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: use structured NewsAnalysis in LLM prompt instead of raw headlines"
```

---

### Task 7: Wire everything in `src/trading-loop.ts` + `src/index.ts`

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/index.ts`
- Modify: `tests/trading-loop.test.ts` (update mocks)

**Step 1: Read `tests/trading-loop.test.ts`** to understand current mock structure before editing.

**Step 2: Update `src/trading-loop.ts`**

Add imports at top:
```typescript
import type { NewsCache } from './news/news-cache.js';
import type { NewsAnalystAgent } from './news/news-analyst.js';
```

Add to `TradingLoopDeps` interface (after `memory`):
```typescript
  newsCache: NewsCache;
  newsAnalyst: NewsAnalystAgent;
  newsConfig: {
    refreshIntervalH: number;
    maxItems: number;
  };
```

Replace the news fetch section in `runOnce()` (currently lines 70-73):
```typescript
      // 4. Refresh news cache if stale, fetch sentiment
      if (this.deps.newsClient && this.deps.newsCache.shouldRefresh(this.deps.newsConfig.refreshIntervalH)) {
        console.log('[News] Cache stale — fetching fresh news...');
        const items = await this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems);
        const analysis = await this.deps.newsAnalyst.analyze(items);
        const cacheState = {
          items,
          fetchedAt: new Date().toISOString(),
          analysis,
          analyzedAt: new Date().toISOString(),
        };
        this.deps.newsCache.save(cacheState);
        this.deps.newsCache.appendHistory(cacheState);
      }
      const newsAnalysis = this.deps.newsCache.getAnalysis() ?? undefined;
      const fearGreed = await fetchFearGreed();
```

Update the `llm.analyze()` call to pass `newsAnalysis` and remove `news`:
```typescript
      const decisions = await llm.analyze({
        snapshots,
        indicators,
        portfolio,
        signals,
        news: [],           // raw headlines no longer used
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        newsAnalysis,
      });
```

In the decisions loop, add FETCH_NEWS handler before the HOLD check:
```typescript
        if (decision.action === 'FETCH_NEWS') {
          console.log(`[News] LLM requested refresh: ${decision.reasoning}`);
          if (this.deps.newsClient) {
            const items = await this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems);
            const analysis = await this.deps.newsAnalyst.analyze(items);
            const cacheState = {
              items,
              fetchedAt: new Date().toISOString(),
              analysis,
              analyzedAt: new Date().toISOString(),
            };
            this.deps.newsCache.save(cacheState);
            this.deps.newsCache.appendHistory(cacheState);
          }
          continue;
        }

        if (decision.action === 'HOLD') continue;
```

**Step 3: Update `src/index.ts`**

Add imports:
```typescript
import { NewsCache } from './news/news-cache.js';
import { NewsAnalystAgent } from './news/news-analyst.js';
```

After creating `llm`, add:
```typescript
  const newsCache = new NewsCache();
  const newsAnalyst = new NewsAnalystAgent(llm);
```

Add to `TradingLoop` constructor:
```typescript
    newsCache,
    newsAnalyst,
    newsConfig: {
      refreshIntervalH: config.trading.newsRefreshIntervalH,
      maxItems: config.trading.newsMaxItems,
    },
```

**Step 4: Update `tests/trading-loop.test.ts`**

Read the file first. Add mocks for `newsCache` and `newsAnalyst`:
```typescript
  newsCache: {
    shouldRefresh: vi.fn().mockReturnValue(false),
    getAnalysis: vi.fn().mockReturnValue(null),
    save: vi.fn(),
    appendHistory: vi.fn(),
  },
  newsAnalyst: {
    analyze: vi.fn().mockResolvedValue({
      market_summary: 'test',
      top_signals: [],
      overall_sentiment: 'neutral',
      macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
      risk_events: [],
    }),
  },
  newsConfig: { refreshIntervalH: 12, maxItems: 100 },
```

**Step 5: Run all tests**

```bash
npx vitest run tests/
```
Expected: all pass

**Step 6: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: 0 errors

**Step 7: Commit**

```bash
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat: wire NewsCache and NewsAnalystAgent into trading loop"
```

---

### Task 8: Final verification

**Step 1: Run full test suite**

```bash
npx vitest run tests/
```
Expected: all pass, 0 failures

**Step 2: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: 0 errors

**Step 3: Restart bot and verify**

```bash
pm2 restart indic-bot
pm2 logs indic-bot --lines 30 --nostream
```
Look for: `[News] Cache stale — fetching fresh news...` then `[NewsAnalyst] Analyzing 100 headlines...` on first cycle.
On subsequent cycles: no Apify calls.

**Step 4: Verify Apify dashboard**

Check Apify console — should see 1 run (startup), then nothing for 12 hours.

**Step 5: Commit any fixes**

```bash
git add -p
git commit -m "fix: news cache integration adjustments"
```
