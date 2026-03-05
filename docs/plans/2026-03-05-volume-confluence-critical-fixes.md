# Volume Ratio, Confluence & Critical Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix volume ratio extrapolation bugs, complete confluence counting (5 factors), add historical trend logging to performance.jsonl, and fix all CRITICAL/IMPORTANT issues from code review.

**Architecture:** Extract confluence calculation into a tested pure function. Fix leverage ordering in trading loop. Wrap all fragile async calls with error handling. Wire 4 unwired components in index.ts. Add TDD tests for every change.

**Tech Stack:** TypeScript, Vitest, Node.js

---

### Task 1: CRITICAL — Fix leverage adjustment ordering

Leverage from filter profile is applied AFTER `orders.execute()` — the Binance order uses unadjusted leverage. Move it before execution.

**Files:**
- Modify: `src/trading-loop.ts:710-725`
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**

In `tests/trading-loop.test.ts`, add a test that verifies leverage is adjusted before execution:

```typescript
it('applies regime leverage multiplier before order execution', async () => {
  // Track the leverage value that orders.execute receives
  let executedLeverage: number | undefined;
  const mockOrders = {
    execute: vi.fn(async (decision: any) => {
      executedLeverage = decision.leverage;
      return { success: true, orderId: '123' };
    }),
  };

  // Set up a BullTrend regime with leverageMultiplier = 0.5
  // Create loop with mocked deps where activeProfile.leverageMultiplier = 0.5
  // Run a cycle that produces a LONG decision with leverage = 10
  // Assert: executedLeverage should be 5 (10 * 0.5), not 10
  expect(executedLeverage).toBe(5);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: FAIL — leverage is 10 (unadjusted)

**Step 3: Write minimal implementation**

In `src/trading-loop.ts`, move the leverage adjustment block (lines 718-722) to BEFORE the `orders.execute()` call (before line 716). Find this code:

```typescript
// BEFORE (wrong order):
const result = await orders.execute(decision, portfolio.balanceUsd);
if (activeProfile && (decision.action === 'LONG' || decision.action === 'SHORT')) {
  decision.leverage = Math.max(1, Math.round(decision.leverage * activeProfile.leverageMultiplier));
}
```

Change to:

```typescript
// AFTER (correct order):
if (activeProfile && (decision.action === 'LONG' || decision.action === 'SHORT')) {
  decision.leverage = Math.max(1, Math.round(decision.leverage * activeProfile.leverageMultiplier));
  console.log(`[Regime] Adjusted leverage for ${decision.pair} to ${decision.leverage}x based on ${marketRegime} profile`);
}
const result = await orders.execute(decision, portfolio.balanceUsd);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "fix(critical): apply regime leverage BEFORE order execution"
```

---

### Task 2: CRITICAL — Wrap runLayer1Experts with error handling

`runLayer1Experts()` uses `Promise.all` — one failing expert kills the entire cycle. Switch to `Promise.allSettled` and make the call site resilient.

**Files:**
- Modify: `src/llm/agents.ts`
- Modify: `src/trading-loop.ts:386-390`
- Test: `tests/llm/agents.test.ts`

**Step 1: Write the failing test**

In `tests/llm/agents.test.ts`, add:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runLayer1Experts } from '../../src/llm/agents.js';

describe('runLayer1Experts', () => {
  it('returns partial results when one expert fails', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn(async (system: string, user: string) => {
        callCount++;
        if (callCount === 2) throw new Error('MacroExpert API timeout');
        return '{"summary": "ok"}';
      }),
    };

    const result = await runLayer1Experts(mockLlm as any, {
      newsData: 'news',
      macroData: 'macro',
      memoryData: 'memory',
    });

    // Should not throw, should return whatever succeeded
    expect(result.newsReport).toBeDefined();
    expect(result.macroReport).toBe(''); // failed expert returns empty
    expect(result.memoryReport).toBeDefined();
  });

  it('returns all empty when all experts fail', async () => {
    const mockLlm = {
      call: vi.fn(async () => { throw new Error('API down'); }),
    };

    const result = await runLayer1Experts(mockLlm as any, {
      newsData: 'news',
      macroData: 'macro',
      memoryData: 'memory',
    });

    expect(result.newsReport).toBe('');
    expect(result.macroReport).toBe('');
    expect(result.memoryReport).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/agents.test.ts`
Expected: FAIL — `runLayer1Experts` throws on expert failure

**Step 3: Write minimal implementation**

In `src/llm/agents.ts`, change `Promise.all` to `Promise.allSettled`:

```typescript
export async function runLayer1Experts(llm: LLMClient, inputs: Layer1Inputs): Promise<Layer1Outputs> {
    const results = await Promise.allSettled([
        llm.call('You are NewsExpert. Summarize catalysts as JSON.', inputs.newsData),
        llm.call('You are MacroExpert. Summarize risk as JSON.', inputs.macroData),
        llm.call('You are MemoryExpert. Review past failures and warn as JSON.', inputs.memoryData),
    ]);

    const extract = (r: PromiseSettledResult<string>) =>
        r.status === 'fulfilled' ? r.value : '';

    return {
        newsReport: extract(results[0]),
        macroReport: extract(results[1]),
        memoryReport: extract(results[2]),
    };
}
```

Also wrap the call site in `src/trading-loop.ts` (around line 386):

```typescript
let layer1Reports: Layer1Outputs = { newsReport: '', macroReport: '', memoryReport: '' };
try {
  layer1Reports = await runLayer1Experts(this.deps.llm, {
    newsData: JSON.stringify(newsAnalysis),
    macroData: JSON.stringify(this.lastMacroAnalysis),
    memoryData: latestMemoryData
  });
} catch (e: any) {
  console.error('[Loop] Layer1 experts failed entirely:', e.message);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/agents.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/agents.ts src/trading-loop.ts tests/llm/agents.test.ts
git commit -m "fix(critical): make Layer1 experts resilient with Promise.allSettled"
```

---

### Task 3: Extract confluence calculation into a pure tested function

Currently confluence is computed inline in trading-loop.ts with only 3 of 5 factors. Extract to `src/market/confluence.ts` with all 5 factors, full TDD.

**Files:**
- Create: `src/market/confluence.ts`
- Create: `tests/market/confluence.test.ts`
- Modify: `src/trading-loop.ts:413-418`

**Step 1: Write the failing tests**

Create `tests/market/confluence.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeConfluence, type ConfluenceInput } from '../../src/market/confluence.js';

describe('computeConfluence', () => {
  const baseInput: ConfluenceInput = {
    trend: 'neutral',
    volumeRatio: 0.5,
    vwap: 100,
    markPrice: 100,
    rsi: 50,
    rsiRange: [30, 70],
    hasNewsCatalyst: false,
  };

  it('returns 0 when no factors align', () => {
    const result = computeConfluence(baseInput);
    expect(result.score).toBe(0);
    expect(result.factors).toHaveLength(0);
  });

  it('counts trend alignment as factor', () => {
    const result = computeConfluence({ ...baseInput, trend: 'bullish' });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('trend');
  });

  it('counts volume > 1x as factor', () => {
    const result = computeConfluence({ ...baseInput, volumeRatio: 1.5 });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('volume');
  });

  it('counts VWAP alignment for bullish trend', () => {
    const result = computeConfluence({
      ...baseInput,
      trend: 'bullish',
      markPrice: 105,
      vwap: 100,
    });
    // trend + vwap = 2
    expect(result.score).toBe(2);
    expect(result.factors).toContain('vwap');
  });

  it('counts VWAP alignment for bearish trend', () => {
    const result = computeConfluence({
      ...baseInput,
      trend: 'bearish',
      markPrice: 95,
      vwap: 100,
    });
    // trend + vwap = 2
    expect(result.score).toBe(2);
    expect(result.factors).toContain('vwap');
  });

  it('does NOT count VWAP when price contradicts trend', () => {
    const result = computeConfluence({
      ...baseInput,
      trend: 'bullish',
      markPrice: 95,  // below VWAP = contradicts bullish
      vwap: 100,
    });
    // only trend, not vwap
    expect(result.score).toBe(1);
    expect(result.factors).not.toContain('vwap');
  });

  it('counts RSI in range as factor', () => {
    const result = computeConfluence({
      ...baseInput,
      rsi: 55,
      rsiRange: [45, 80],  // BullTrend RSI range
    });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('rsi');
  });

  it('does NOT count RSI outside range', () => {
    const result = computeConfluence({
      ...baseInput,
      rsi: 85,
      rsiRange: [45, 80],
    });
    expect(result.score).toBe(0);
    expect(result.factors).not.toContain('rsi');
  });

  it('counts news catalyst as factor', () => {
    const result = computeConfluence({ ...baseInput, hasNewsCatalyst: true });
    expect(result.score).toBe(1);
    expect(result.factors).toContain('news');
  });

  it('returns max 5 when all factors align', () => {
    const result = computeConfluence({
      trend: 'bullish',
      volumeRatio: 2.0,
      vwap: 100,
      markPrice: 105,
      rsi: 55,
      rsiRange: [45, 80],
      hasNewsCatalyst: true,
    });
    expect(result.score).toBe(5);
    expect(result.factors).toHaveLength(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/confluence.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/market/confluence.ts`:

```typescript
export interface ConfluenceInput {
  trend: 'bullish' | 'bearish' | 'neutral';
  volumeRatio: number;
  vwap: number;
  markPrice: number;
  rsi: number;
  rsiRange: [number, number];
  hasNewsCatalyst: boolean;
}

export interface ConfluenceResult {
  score: number;
  factors: string[];
}

export function computeConfluence(input: ConfluenceInput): ConfluenceResult {
  const factors: string[] = [];

  // 1. Trend alignment (EMA20 vs EMA50)
  if (input.trend === 'bullish' || input.trend === 'bearish') {
    factors.push('trend');
  }

  // 2. Volume above average
  if (input.volumeRatio > 1) {
    factors.push('volume');
  }

  // 3. VWAP alignment with trend
  if (input.trend === 'bullish' && input.markPrice > input.vwap) {
    factors.push('vwap');
  } else if (input.trend === 'bearish' && input.markPrice < input.vwap) {
    factors.push('vwap');
  }

  // 4. RSI in acceptable range for current regime
  if (input.rsi >= input.rsiRange[0] && input.rsi <= input.rsiRange[1]) {
    factors.push('rsi');
  }

  // 5. News/macro catalyst present
  if (input.hasNewsCatalyst) {
    factors.push('news');
  }

  return { score: factors.length, factors };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/market/confluence.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/market/confluence.ts tests/market/confluence.test.ts
git commit -m "feat: extract confluence calculation into pure tested function (5 factors)"
```

---

### Task 4: Wire confluence into trading loop and add volume/confluence to performance.jsonl

Replace inline confluence in trading-loop with the new function. Log volumeRatio, confluence score, and regime to performance.jsonl for historical trend.

**Files:**
- Modify: `src/trading-loop.ts:413-425` (confluence) and performance logging section
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**

In `tests/trading-loop.test.ts`, add test verifying that performance log includes volumeRatio and confluence:

```typescript
it('logs volumeRatio and confluence to performance snapshot', async () => {
  // Run a cycle, capture what logger.logPerformance receives
  // Assert it contains: volumeRatio, confluenceScore, confluenceFactors, regime
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: FAIL — performance log doesn't include these fields

**Step 3: Wire confluence and extend performance logging**

In `src/trading-loop.ts`, replace the inline confluence block (lines 413-425) with:

```typescript
import { computeConfluence, type ConfluenceInput } from './market/confluence.js';

// ... inside runOnce(), replace lines 413-425:
let filterWarning: string | undefined = undefined;
const btcInd = indicators.get(btcSnap?.pair ?? '');
let confluenceResult = { score: 0, factors: [] as string[] };

if (activeProfile && btcInd && portfolio.positions.length === 0) {
  const hasNewsCatalyst = newsAnalysis?.top_signals?.some(
    (s: any) => s.importance >= 7
  ) ?? false;

  confluenceResult = computeConfluence({
    trend: btcInd.trend,
    volumeRatio: btcInd.volumeRatio,
    vwap: btcInd.vwap,
    markPrice: parseFloat(btcSnap.markPrice),
    rsi: btcInd.rsi,
    rsiRange: activeProfile.rsiRange,
    hasNewsCatalyst,
  });

  if (btcInd.volumeRatio < activeProfile.volumeMin) {
    filterWarning = `Volume ${btcInd.volumeRatio.toFixed(2)}x < ${activeProfile.volumeMin}x required for ${marketRegime}`;
  } else if (confluenceResult.score < activeProfile.confluenceMin) {
    filterWarning = `Confluence ${confluenceResult.score}/5 [${confluenceResult.factors.join(',')}] < ${activeProfile.confluenceMin} required for ${marketRegime}`;
  }
}
```

Then extend the performance logging (find `logger.logPerformance` call) to include:

```typescript
logger.logPerformance({
  // ... existing fields ...
  volumeRatio: btcInd?.volumeRatio ?? null,
  confluenceScore: confluenceResult.score,
  confluenceFactors: confluenceResult.factors,
  regime: marketRegime,
  regimeConfidence,
});
```

**Step 4: Run tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: wire 5-factor confluence + log volume/confluence to performance.jsonl"
```

---

### Task 5: IMPORTANT — Wire 4 unwired components in index.ts

DevilsAdvocate, FlashCrashScanner, DecisionJournal, TradeStoryLogger are implemented but never instantiated in index.ts.

**Files:**
- Modify: `src/index.ts`
- Read: `src/trading-loop.ts` (TradingLoopDeps interface for expected dep names)

**Step 1: Read index.ts and TradingLoopDeps**

Check what the deps interface expects and how existing deps are wired.

**Step 2: Wire the 4 components**

In `src/index.ts`, add imports and instantiation:

```typescript
import { FlashCrashScanner } from './news/flash-crash.js';
import { DevilsAdvocate } from './risk/devils-advocate.js';
import { DecisionJournal } from './logging/decision-journal.js';
import { TradeStoryLogger } from './logging/trade-story.js';

// After GrokClient instantiation:
const flashCrashScanner = grokClient ? new FlashCrashScanner(grokClient) : undefined;
const devilsAdvocate = grokClient ? new DevilsAdvocate(grokClient) : undefined;
const decisionJournal = new DecisionJournal();
const tradeStoryLogger = new TradeStoryLogger();

// Pass to TradingLoop deps:
// flashCrashScanner,
// devilsAdvocate,
// decisionJournal,
// tradeStoryLogger,
```

**Step 3: Verify build compiles**

Run: `npm run build`
Expected: No type errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix: wire FlashCrashScanner, DevilsAdvocate, DecisionJournal, TradeStoryLogger in index.ts"
```

---

### Task 6: IMPORTANT — Add timeout to EmbeddingClient

`EmbeddingClient` uses raw `fetch` without timeout — can hang forever.

**Files:**
- Modify: `src/llm/embedding-client.ts`
- Test: `tests/llm/embedding-client.test.ts`

**Step 1: Write the failing test**

In `tests/llm/embedding-client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../../src/llm/embedding-client.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});
```

**Step 2: Modify implementation to use fetchWithTimeout**

In `src/llm/embedding-client.ts`, replace raw `fetch` with `fetchWithTimeout`:

```typescript
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

// Replace:
const response = await fetch('https://api.openai.com/v1/embeddings', {
// With:
const response = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
    },
    body: JSON.stringify({
        input: text,
        model: 'text-embedding-3-small'
    })
}, 15000);  // 15s timeout, same as Apify
```

**Step 3: Run tests**

Run: `npx vitest run tests/llm/embedding-client.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/llm/embedding-client.ts tests/llm/embedding-client.test.ts
git commit -m "fix: add 15s timeout to EmbeddingClient fetch calls"
```

---

### Task 7: IMPORTANT — Make SwarmAgent JSON parsing resilient

Two bugs: (1) regex can't match nested objects, (2) no try/catch around `this.llm.call()`.

**Files:**
- Modify: `src/llm/swarm-agent.ts`
- Test: `tests/llm/swarm-agent.test.ts`

**Step 1: Write the failing tests**

In `tests/llm/swarm-agent.test.ts`, add:

```typescript
describe('SwarmAgent consensus parsing', () => {
  it('returns empty array when llm.call throws', async () => {
    const mockLlm = {
      call: vi.fn(async () => { throw new Error('API down'); }),
    };
    const agent = new SwarmAgent(mockLlm as any);
    const result = await agent.getConsensus(/* test params */);
    expect(result).toEqual([]);
  });

  it('parses JSON with nested objects in decisions', async () => {
    const mockLlm = {
      call: vi.fn(async () => JSON.stringify({
        decisions: [{
          pair: 'BTCUSDT',
          action: 'LONG',
          reasoning: 'test',
          confidence: 70,
          nested: { some: 'data' }
        }],
        next_check_minutes: 5
      })),
    };
    const agent = new SwarmAgent(mockLlm as any);
    const result = await agent.getConsensus(/* test params */);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('LONG');
  });
});
```

**Step 2: Fix implementation**

In `src/llm/swarm-agent.ts`, wrap the consensus call and improve JSON extraction:

```typescript
// Wrap the entire consensus call
let rawConsensus: string;
try {
  rawConsensus = await this.llm.call(consensusPrompt, userPrompt);
} catch (e: any) {
  console.error('[Swarm] Consensus LLM call failed:', e.message);
  return [];
}

// Use the same smart extraction as LLMClient (find outermost { } containing "decisions")
let jsonStr: string | undefined;
try {
  // Find the outermost JSON block containing "decisions"
  const startIdx = rawConsensus.indexOf('{');
  if (startIdx >= 0) {
    let depth = 0;
    for (let i = startIdx; i < rawConsensus.length; i++) {
      if (rawConsensus[i] === '{') depth++;
      if (rawConsensus[i] === '}') depth--;
      if (depth === 0) {
        jsonStr = rawConsensus.slice(startIdx, i + 1);
        break;
      }
    }
  }
} catch {}

if (!jsonStr) {
  console.error('[Swarm] Consensus parser failed to find JSON');
  return [];
}

try {
  const parsed = JSON.parse(jsonStr);
  this.llm.lastNextCheckMinutes = parsed.next_check_minutes;
  return parsed.decisions || [];
} catch (e) {
  console.error('[Swarm] Consensus JSON invalid', e);
  return [];
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "fix: make SwarmAgent resilient to LLM failures and nested JSON"
```

---

### Task 8: IMPORTANT — Add size limit to EpisodicStore

`memory-graph.json` grows unbounded. Add a max episodes cap (500) with oldest-first eviction.

**Files:**
- Modify: `src/memory/episodic-store.ts`
- Test: `tests/memory/episodic-store.test.ts`

**Step 1: Write the failing test**

In `tests/memory/episodic-store.test.ts`:

```typescript
describe('EpisodicStore size limit', () => {
  it('evicts oldest episodes when exceeding max size', () => {
    const store = new EpisodicStore('/tmp/test-graph.json', 5); // max 5
    for (let i = 0; i < 7; i++) {
      store.addEpisode({
        id: `ep-${i}`,
        timestamp: new Date(2026, 0, 1 + i).toISOString(),
        textSummary: `Episode ${i}`,
        embedding: [i, i, i],
        resultPnl: i * 0.1,
      });
    }
    const episodes = store.getAll();
    expect(episodes).toHaveLength(5);
    expect(episodes[0].id).toBe('ep-2'); // oldest 2 evicted
    expect(episodes[4].id).toBe('ep-6');
  });
});
```

**Step 2: Implement**

In `src/memory/episodic-store.ts`, add max size parameter and eviction in `addEpisode`:

```typescript
export class EpisodicStore {
  private episodes: Episode[] = [];
  private readonly filePath: string;
  private readonly maxEpisodes: number;

  constructor(filePath: string, maxEpisodes = 500) {
    this.filePath = filePath;
    this.maxEpisodes = maxEpisodes;
    this.load();
  }

  addEpisode(episode: Episode) {
    this.episodes.push(episode);
    if (this.episodes.length > this.maxEpisodes) {
      this.episodes = this.episodes.slice(-this.maxEpisodes);
    }
    this.save();
  }

  getAll(): Episode[] {
    return this.episodes;
  }
  // ... rest unchanged
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/memory/episodic-store.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/episodic-store.ts tests/memory/episodic-store.test.ts
git commit -m "fix: add 500-episode size limit to EpisodicStore with oldest-first eviction"
```

---

### Task 9: IMPORTANT — Remove dead CoT schema code

`cot-schema.ts` is not imported anywhere in production code. Remove it to reduce dead code.

**Files:**
- Delete: `src/llm/cot-schema.ts`
- Delete: `tests/llm/cot-schema.test.ts`

**Step 1: Verify no imports**

Run: `grep -r "cot-schema" src/`
Expected: No results

**Step 2: Delete files**

```bash
rm src/llm/cot-schema.ts tests/llm/cot-schema.test.ts
```

**Step 3: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove dead cot-schema code (never imported in production)"
```

---

### Task 10: Run full test suite and build verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Run build**

Run: `npm run build`
Expected: No errors

**Step 3: Final commit if any remaining changes**

```bash
git status
# If clean, done. If not, commit remaining.
```
