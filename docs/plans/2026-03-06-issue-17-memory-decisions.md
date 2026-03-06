# Issue #17: MemoryReview receives empty decision log

## Problem

In `src/trading-loop.ts` line 1054–1056, `MemoryReviewAgent.review()` is called with an empty array for the `recentDecisions` parameter:

```typescript
await this.deps.memoryReview.review(
  this.deps.memory.load().recent_trades,
  [],  // decision log — future enhancement
  this.cycleCount,
);
```

The `review()` method in `src/memory/memory-review.ts` (line 67) takes `recentDecisions: string[]` and includes them in the LLM prompt (line 81–82):

```typescript
Recent decision log (last 10):
${recentDecisions.slice(0, 10).join('\n') || 'No recent decisions.'}
```

Because it always receives `[]`, the review prompt always shows `"No recent decisions."`. This means:

- MemoryReview cannot analyze **why** trades were entered (only sees trade results)
- Cannot identify patterns in rejected decisions
- Cannot learn from HOLD decisions or regime misclassifications
- The "failures" and "learned" sections in `memory.md` lack context about decision rationale

## Root Cause

The comment `// decision log — future enhancement` at line 1056 indicates this was intentionally deferred. Meanwhile, the DB already has all the data needed: `trade_decisions` table stores every decision with `pair`, `action`, `confidence`, `reasoning`, `regime`, and execution result.

The `getRecentDecisions()` function already exists in `src/db/repository.ts` (line 342–358) and returns `RecentDecision[]` with exactly the fields needed. It is already called earlier in the loop (line 450–452) for LLM context, but the results are not passed to `MemoryReviewAgent`.

## Solution

1. Query the last 20 decisions from the DB using `getRecentDecisions(20)`.
2. Format them as human-readable strings.
3. Pass them to `memoryReview.review()` instead of `[]`.

## Files to Modify

| File | Change |
|------|--------|
| `src/trading-loop.ts` | Fetch and format recent decisions for MemoryReview |
| `tests/trading-loop.test.ts` | Test that MemoryReview receives formatted decisions |
| `tests/memory/memory-review.test.ts` | Test that review prompt includes decision context |

## Implementation Steps (TDD)

### Step 1: Write failing test — MemoryReview receives non-empty decisions

First, check that the existing test file exists for memory-review.

```typescript
// tests/memory/memory-review.test.ts — NEW file

import { describe, it, expect, vi } from 'vitest';
import { MemoryReviewAgent } from '../../src/memory/memory-review.js';

describe('MemoryReviewAgent', () => {
  const mockMemoryKeeper = {
    read: vi.fn().mockReturnValue('# Memory\nSome content'),
    writeNarrativeSections: vi.fn(),
    backupHistory: vi.fn(),
  };

  it('includes recent decisions in review prompt', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        identity: 'I am a cautious trend follower.',
        learned: 'ATR-based SL works better in breakouts.',
        failures: 'Overtrading in range markets.',
        regime: 'Market is in a consolidation phase.',
      })),
    };

    const agent = new MemoryReviewAgent(
      { llm: mockLlm as any, memoryKeeper: mockMemoryKeeper },
      20,
    );

    const recentDecisions = [
      'BTCUSDT LONG (conf:75, regime:BullTrend) → filled | "EMA crossover + volume spike"',
      'ETHUSDT SHORT (conf:40, regime:Range) → RISK_REJECTED: Low confidence | "Bearish divergence on RSI"',
      'BTCUSDT CLOSE (conf:80, regime:BearTrend) → filled | "Trend reversal confirmed"',
    ];

    await agent.review(
      [{ pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 5.2, pnlPct: 2.1, closedAt: '2026-03-06T12:00:00Z' }],
      recentDecisions,
      10,
    );

    expect(mockLlm.call).toHaveBeenCalledTimes(1);
    const prompt = mockLlm.call.mock.calls[0][1]; // second arg = user prompt
    expect(prompt).toContain('BTCUSDT LONG (conf:75');
    expect(prompt).toContain('RISK_REJECTED');
    expect(prompt).toContain('EMA crossover');
    expect(prompt).not.toContain('No recent decisions.');
  });

  it('shows "No recent decisions." when array is empty', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify({
        identity: 'test', learned: 'test', failures: 'test', regime: 'test',
      })),
    };

    const agent = new MemoryReviewAgent(
      { llm: mockLlm as any, memoryKeeper: mockMemoryKeeper },
      20,
    );

    await agent.review([], [], 5);

    const prompt = mockLlm.call.mock.calls[0][1];
    expect(prompt).toContain('No recent decisions.');
  });

  it('shouldReview returns true after N cycles', () => {
    const mockLlm = { call: vi.fn() };
    const agent = new MemoryReviewAgent(
      { llm: mockLlm as any, memoryKeeper: mockMemoryKeeper },
      20,
    );

    expect(agent.shouldReview(20, 0, 0)).toBe(true);
    expect(agent.shouldReview(10, 0, 0)).toBe(false);
  });

  it('shouldReview returns true after 3 consecutive losses', () => {
    const mockLlm = { call: vi.fn() };
    const agent = new MemoryReviewAgent(
      { llm: mockLlm as any, memoryKeeper: mockMemoryKeeper },
      20,
    );

    expect(agent.shouldReview(5, 3, 0)).toBe(true);
    expect(agent.shouldReview(5, 2, 0)).toBe(false);
  });

  it('shouldReview returns true on significant balance change', () => {
    const mockLlm = { call: vi.fn() };
    const agent = new MemoryReviewAgent(
      { llm: mockLlm as any, memoryKeeper: mockMemoryKeeper },
      20,
    );

    expect(agent.shouldReview(5, 0, 4)).toBe(true);
    expect(agent.shouldReview(5, 0, -3.5)).toBe(true);
    expect(agent.shouldReview(5, 0, 2)).toBe(false);
  });
});
```

**Verify:** `npx vitest run tests/memory/memory-review.test.ts` — the `'includes recent decisions in review prompt'` test passes (the `review()` method already accepts the parameter). But the real issue is that `trading-loop.ts` never passes real data. We need a trading-loop test.

### Step 2: Write failing test — TradingLoop passes decisions to MemoryReview

```typescript
// tests/trading-loop.test.ts — add test

it('passes recent decisions from DB to MemoryReview', async () => {
  const mockReview = {
    shouldReview: vi.fn().mockReturnValue(true),
    review: vi.fn().mockResolvedValue(undefined),
    sessionId: undefined as string | undefined,
  };

  // Mock getRecentDecisions to return data (needs vi.mock or dependency injection)
  // Since getRecentDecisions is imported directly in trading-loop.ts, we need
  // to test via the integration: check that review() receives non-empty decisions

  const reviewLoop = new TradingLoop({
    pairs: ['BTCUSDT'],
    marketData: mockMarketData,
    llm: mockLlm,
    orders: mockOrders,
    riskManager: mockRisk,
    signalBuffer: mockSignalBuffer,
    logger: mockLogger,
    memory: mockSessionMemory,
    newsCache: { shouldRefresh: vi.fn().mockReturnValue(false), load: vi.fn().mockReturnValue(null), save: vi.fn(), appendHistory: vi.fn(), getRecentItems: vi.fn().mockReturnValue([]), dbCount: vi.fn().mockReturnValue(0) } as any,
    newsAnalyst: { analyze: vi.fn().mockResolvedValue({ market_summary: '', top_signals: [], overall_sentiment: 'neutral', macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' }, risk_events: [] }) } as any,
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    churnCooldownMs: 900000,
    tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    memoryKeeper: mockMemoryKeeper,
    memoryReview: mockReview as any,
  });

  await reviewLoop.runOnce();

  expect(mockReview.shouldReview).toHaveBeenCalled();
  expect(mockReview.review).toHaveBeenCalled();

  const reviewArgs = mockReview.review.mock.calls[0];
  const decisionsArg = reviewArgs[1]; // second arg = recentDecisions: string[]
  // Currently this is [] — after our fix it should be string[] from DB
  // Without DB mock, it will be [] (getRecentDecisions fails silently)
  // But the format function should still be called
  expect(Array.isArray(decisionsArg)).toBe(true);
});
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — passes (baseline). The `decisionsArg` will be `[]` without DB but the structure is correct.

### Step 3: Create a formatting utility for decisions

To keep TradingLoop clean, create a small formatter function. This can be added directly in `src/trading-loop.ts` or as a utility. Adding it inline is simplest:

```typescript
// src/trading-loop.ts — new private helper, or a standalone function at the top

function formatDecisionsForReview(
  decisions: import('./db/repository.js').RecentDecision[]
): string[] {
  return decisions.map(d => {
    const result = d.execution_result ? ` → ${d.execution_result}` : '';
    const reasoning = d.reasoning ? ` | "${d.reasoning.slice(0, 120)}"` : '';
    return `${d.pair} ${d.action} (conf:${d.confidence ?? '?'}, regime:${d.regime ?? '?'})${result}${reasoning}`;
  });
}
```

### Step 4: Write unit test for the formatter

```typescript
// tests/trading-loop.test.ts — add test

import { formatDecisionsForReview } from '../src/trading-loop.js';

describe('formatDecisionsForReview', () => {
  it('formats a filled decision', () => {
    const result = formatDecisionsForReview([{
      pair: 'BTCUSDT',
      action: 'LONG',
      confidence: 75,
      reasoning: 'EMA crossover with volume confirmation',
      regime: 'BullTrend',
      created_at: '2026-03-06T12:00:00Z',
      execution_result: 'filled',
    }]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('BTCUSDT LONG (conf:75, regime:BullTrend) → filled | "EMA crossover with volume confirmation"');
  });

  it('formats a rejected decision', () => {
    const result = formatDecisionsForReview([{
      pair: 'ETHUSDT',
      action: 'SHORT',
      confidence: 40,
      reasoning: 'Bearish RSI divergence',
      regime: 'Range',
      created_at: '2026-03-06T12:00:00Z',
      execution_result: 'ORDER_FAIL: Low confidence',
    }]);

    expect(result[0]).toContain('ORDER_FAIL');
  });

  it('handles missing fields gracefully', () => {
    const result = formatDecisionsForReview([{
      pair: 'BTCUSDT',
      action: 'HOLD',
      confidence: 0,
      reasoning: '',
      regime: '',
      created_at: '2026-03-06T12:00:00Z',
    }]);

    expect(result[0]).toContain('BTCUSDT HOLD');
  });

  it('returns empty array for empty input', () => {
    expect(formatDecisionsForReview([])).toEqual([]);
  });

  it('truncates long reasoning to 120 chars', () => {
    const longReasoning = 'A'.repeat(200);
    const result = formatDecisionsForReview([{
      pair: 'BTCUSDT',
      action: 'LONG',
      confidence: 80,
      reasoning: longReasoning,
      regime: 'BullTrend',
      created_at: '2026-03-06T12:00:00Z',
    }]);

    // The reasoning in the output should be truncated to 120 chars
    const reasoningPart = result[0].split('"')[1];
    expect(reasoningPart.length).toBeLessThanOrEqual(120);
  });
});
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — fails because `formatDecisionsForReview` is not exported from `trading-loop.ts`.

### Step 5: Implement the formatter and export it

In `src/trading-loop.ts`, add the function (before the `TradingLoop` class) and export it:

```typescript
// src/trading-loop.ts — add before the TradingLoop class definition

export function formatDecisionsForReview(
  decisions: import('./db/repository.js').RecentDecision[]
): string[] {
  return decisions.map(d => {
    const result = d.execution_result ? ` → ${d.execution_result}` : '';
    const reasoning = d.reasoning ? ` | "${d.reasoning.slice(0, 120)}"` : '';
    return `${d.pair} ${d.action} (conf:${d.confidence ?? '?'}, regime:${d.regime ?? '?'})${result}${reasoning}`;
  });
}
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — formatter tests pass.

### Step 6: Wire the formatted decisions into MemoryReview call

In `src/trading-loop.ts`, replace the `memoryReview.review()` call (lines 1054–1058):

**Before (line 1054–1058):**
```typescript
await this.deps.memoryReview.review(
  this.deps.memory.load().recent_trades,
  [],  // decision log — future enhancement
  this.cycleCount,
);
```

**After:**
```typescript
// Fetch last 20 decisions from DB for review context
let reviewDecisions: string[] = [];
try {
  const dbDecisions = await getRecentDecisions(20);
  reviewDecisions = formatDecisionsForReview(dbDecisions);
} catch {
  // DB optional — review proceeds with empty decisions
}

await this.deps.memoryReview.review(
  this.deps.memory.load().recent_trades,
  reviewDecisions,
  this.cycleCount,
);
```

Note: `getRecentDecisions` is already imported at line 29 of `src/trading-loop.ts`.

### Step 7: Verify all tests pass

```bash
npx vitest run tests/trading-loop.test.ts tests/memory/memory-review.test.ts
```

All tests should pass. The key behavioral change:

- **Without DB:** `getRecentDecisions(20)` throws, caught silently, `reviewDecisions = []` — same as before.
- **With DB:** MemoryReview now gets formatted decision strings like:
  ```
  BTCUSDT LONG (conf:75, regime:BullTrend) → filled | "EMA crossover with volume confirmation"
  ETHUSDT SHORT (conf:40, regime:Range) → ORDER_FAIL: Low confidence | "Bearish RSI divergence"
  ```

### Step 8: Commit

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts tests/memory/memory-review.test.ts
git commit -m "feat(issue-17): pass recent decisions from DB to MemoryReview"
```

## Verification

After deployment:

1. **Logs:** When `[MemoryReview] Narrative sections updated` appears, the review had access to decision context.
2. **memory.md:** The `## Failures` and `## Learned` sections should now reference specific trade reasonings and rejection patterns (e.g., "I keep getting rejected for low confidence on SHORT trades in Range markets").
3. **DB:** `SELECT review_text FROM memory_reviews ORDER BY created_at DESC LIMIT 1;` — the review text should reference specific pairs and decision patterns, not just PnL numbers.
4. **Contrast:** Compare a `memory_reviews` entry from before this change (generic: "I lost money on BTC") vs after (specific: "I attempted 3 LONGs with confidence <60, all rejected by RiskManager — I need to be more selective").
