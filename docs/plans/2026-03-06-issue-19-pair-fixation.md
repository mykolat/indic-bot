# Issue #19: LLM Pair Fixation — Diversity Prompt + Multi-TF Relaxation

**Status:** Plan
**Created:** 2026-03-06
**Branch:** `feat/max-info-fetch`
**Depends on:** Issue #15 (per-pair confluence)

## Problem

100% of trades concentrate on a single pair (ADAUSDT). Out of 16 decisions, 13 target the same pair in the same direction. The LLM fixates because:

1. **Per-pair confluence is BTC-only (Issue #15).** All pairs share the same confluence gate, and whichever pair the LLM tried first that worked becomes the anchor.
2. **Multi-TF rule is too strict.** System prompt says "LONG only if 1h AND 4h trends align bullish." Most altcoins have 4h trend = neutral (ADX < 20), so only the one pair that happens to have both aligned gets picked repeatedly.
3. **No diversity signal in prompt.** LLM has no awareness of how concentrated its recent decisions have been.
4. **No rotation tracking.** The system doesn't show the LLM which pairs it has been ignoring.

## Solution

Four-pronged approach:

1. **Per-pair confluence** (Issue #15 prerequisite) — each pair judged individually
2. **Diversity prompt injection** — show LLM which pair it traded last N cycles, warn about concentration
3. **Relax multi-TF rule** — allow entry if 1h aligned + 4h neutral (not just both aligned)
4. **Pair rotation tracking** — show cycles-since-last-trade per pair in prompt context

## Detailed Design

### New Data Structures

**`src/trading-loop.ts`** — Add pair history tracking:

```typescript
// In TradingLoop class (new private field):
private pairDecisionHistory: Array<{ pair: string; action: string; cycle: number }> = [];
```

**`src/llm/prompts.ts`** — New fields in `EnrichedPromptData`:

```typescript
pairDiversityContext?: {
  recentPairActions: Array<{ pair: string; action: string; cyclesAgo: number }>;
  cyclesSinceLastTrade: Map<string, number>;  // pair → cycles since last LONG/SHORT
  concentrationWarning?: string;  // e.g. "13/16 decisions = ADAUSDT"
};
```

### Prompt Injection

New section in `buildEnrichedPrompt()` between regime and technical analysis:

```
## Pair Diversity Context
Recent entry decisions (last 10 cycles):
  1 cycle ago: ADAUSDT LONG
  3 cycles ago: ADAUSDT LONG
  5 cycles ago: ADAUSDT LONG

Cycles since last entry per pair:
  BTCUSDT: 15 cycles (never traded)
  ETHUSDT: 12 cycles (never traded)
  SOLUSDT: 8 cycles
  ADAUSDT: 1 cycle (RECENT)
  ...

>>> CONCENTRATION WARNING <<<
You have traded ADAUSDT 5 out of the last 10 entry decisions.
REQUIREMENT: Evaluate ALL pairs equally. If another pair has confluence >= 2
and acceptable setup, prefer it over ADAUSDT to diversify risk.
Do NOT fixate on one pair. Spread exposure across the portfolio.
```

### Multi-TF Relaxation

**Current rule** (`src/llm/prompts.ts:35-37`):
```
- LONG: Only if 1h AND 4h trends align bullish (EMA20 > EMA50).
  If only 1h bullish but 4h bearish, HOLD or use minimal leverage (3-5x).
- SHORT: Only if 1h AND 4h trends align bearish.
```

**New rule:**
```
- LONG: Preferred if 1h AND 4h trends align bullish. ALSO allowed if 1h is bullish
  and 4h is NEUTRAL (not bearish) — use reduced leverage (5-8x max).
  If 1h bullish but 4h bearish, HOLD.
- SHORT: Preferred if 1h AND 4h align bearish. ALSO allowed if 1h is bearish
  and 4h is NEUTRAL (not bullish) — use reduced leverage (5-8x max).
  If 1h bearish but 4h bullish, HOLD.
```

This widens the entry window from "both aligned" to "1h aligned + 4h not opposing", which should allow more pairs to qualify.

## Implementation Steps (TDD)

### Step 1: Test — pairDecisionHistory tracks recent trades

**File:** `tests/trading-loop.test.ts`

```typescript
it('tracks pair decision history across cycles', async () => {
  // Cycle 1: LLM decides LONG ADAUSDT
  mockLlm.analyze = vi.fn()
    .mockResolvedValueOnce([
      { pair: 'ADAUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'bullish', confidence: 70 },
    ])
    .mockResolvedValueOnce([
      { pair: 'BTCUSDT', action: 'HOLD', reasoning: 'test', confidence: 50 },
    ]);

  await loop.runOnce();
  await loop.runOnce();

  // The second call to analyze should receive pairDiversityContext
  const secondCallData = mockLlm.analyze.mock.calls[1]?.[0];
  expect(secondCallData.pairDiversityContext).toBeDefined();
  expect(secondCallData.pairDiversityContext.recentPairActions).toBeDefined();
  expect(secondCallData.pairDiversityContext.recentPairActions.length).toBeGreaterThan(0);
  expect(secondCallData.pairDiversityContext.recentPairActions[0].pair).toBe('ADAUSDT');
});
```

**Run:** `npx vitest run tests/trading-loop.test.ts`
**Expected:** FAIL — `pairDiversityContext` does not exist in promptData.

### Step 2: Test — concentration warning triggers when same pair dominates

**File:** `tests/trading-loop.test.ts`

```typescript
it('generates concentration warning when >50% decisions on one pair', async () => {
  // Simulate 6 consecutive ADAUSDT decisions in history
  // (We'll need to expose pairDecisionHistory or test through promptData)

  // For now, test the helper function directly:
  const { buildDiversityContext } = await import('../src/market/pair-diversity.js');

  const history = [
    { pair: 'ADAUSDT', action: 'LONG', cycle: 10 },
    { pair: 'ADAUSDT', action: 'LONG', cycle: 8 },
    { pair: 'ADAUSDT', action: 'LONG', cycle: 6 },
    { pair: 'SOLUSDT', action: 'SHORT', cycle: 4 },
    { pair: 'ADAUSDT', action: 'LONG', cycle: 2 },
  ];
  const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'];

  const ctx = buildDiversityContext(history, pairs, 11);

  expect(ctx.concentrationWarning).toBeDefined();
  expect(ctx.concentrationWarning).toContain('ADAUSDT');
  expect(ctx.concentrationWarning).toContain('3'); // 3 out of 5 recent
  expect(ctx.cyclesSinceLastTrade.get('BTCUSDT')).toBeGreaterThan(10);
  expect(ctx.cyclesSinceLastTrade.get('ADAUSDT')).toBe(1);
});
```

**Run:** `npx vitest run tests/trading-loop.test.ts`
**Expected:** FAIL — `pair-diversity.ts` does not exist.

### Step 3: Implement — Pair diversity module

**File:** `src/market/pair-diversity.ts` (NEW)

```typescript
export interface PairAction {
  pair: string;
  action: string;
  cycle: number;
}

export interface PairDiversityContext {
  recentPairActions: Array<{ pair: string; action: string; cyclesAgo: number }>;
  cyclesSinceLastTrade: Map<string, number>;
  concentrationWarning?: string;
}

export function buildDiversityContext(
  history: PairAction[],
  allPairs: string[],
  currentCycle: number,
  lookback = 10,
): PairDiversityContext {
  // Filter to entry actions only (LONG/SHORT), most recent first
  const entries = history
    .filter(h => h.action === 'LONG' || h.action === 'SHORT')
    .sort((a, b) => b.cycle - a.cycle)
    .slice(0, lookback);

  const recentPairActions = entries.map(e => ({
    pair: e.pair,
    action: e.action,
    cyclesAgo: currentCycle - e.cycle,
  }));

  // Cycles since last trade per pair
  const cyclesSinceLastTrade = new Map<string, number>();
  for (const pair of allPairs) {
    const lastEntry = entries.find(e => e.pair === pair);
    cyclesSinceLastTrade.set(pair, lastEntry ? currentCycle - lastEntry.cycle : currentCycle);
  }

  // Concentration detection
  let concentrationWarning: string | undefined;
  if (entries.length >= 3) {
    const pairCounts = new Map<string, number>();
    for (const e of entries) {
      pairCounts.set(e.pair, (pairCounts.get(e.pair) ?? 0) + 1);
    }
    for (const [pair, count] of pairCounts) {
      const pct = (count / entries.length) * 100;
      if (pct > 50) {
        concentrationWarning = `You have traded ${pair} ${count} out of the last ${entries.length} entry decisions (${pct.toFixed(0)}%). Evaluate ALL pairs equally. If another pair has confluence >= 2 and acceptable setup, prefer diversification.`;
      }
    }
  }

  return { recentPairActions, cyclesSinceLastTrade, concentrationWarning };
}
```

**Run:** `npx vitest run tests/trading-loop.test.ts`
**Expected:** The `buildDiversityContext` test should now PASS. The `pairDiversityContext` in promptData test still FAILS (not wired yet).

### Step 4: Test — buildDiversityContext unit tests

**File:** `tests/market/pair-diversity.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';
import { buildDiversityContext, type PairAction } from '../../src/market/pair-diversity.js';

describe('buildDiversityContext', () => {
  const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'];

  it('returns empty context when no history', () => {
    const ctx = buildDiversityContext([], pairs, 1);
    expect(ctx.recentPairActions).toHaveLength(0);
    expect(ctx.concentrationWarning).toBeUndefined();
    expect(ctx.cyclesSinceLastTrade.get('BTCUSDT')).toBe(1);
  });

  it('tracks cyclesSinceLastTrade per pair', () => {
    const history: PairAction[] = [
      { pair: 'ADAUSDT', action: 'LONG', cycle: 10 },
      { pair: 'SOLUSDT', action: 'SHORT', cycle: 5 },
    ];
    const ctx = buildDiversityContext(history, pairs, 12);

    expect(ctx.cyclesSinceLastTrade.get('ADAUSDT')).toBe(2);  // 12 - 10
    expect(ctx.cyclesSinceLastTrade.get('SOLUSDT')).toBe(7);  // 12 - 5
    expect(ctx.cyclesSinceLastTrade.get('BTCUSDT')).toBe(12); // never traded
    expect(ctx.cyclesSinceLastTrade.get('ETHUSDT')).toBe(12); // never traded
  });

  it('generates concentration warning when >50% on one pair', () => {
    const history: PairAction[] = [
      { pair: 'ADAUSDT', action: 'LONG', cycle: 10 },
      { pair: 'ADAUSDT', action: 'LONG', cycle: 9 },
      { pair: 'ADAUSDT', action: 'SHORT', cycle: 8 },
      { pair: 'SOLUSDT', action: 'LONG', cycle: 7 },
    ];
    const ctx = buildDiversityContext(history, pairs, 11);

    expect(ctx.concentrationWarning).toBeDefined();
    expect(ctx.concentrationWarning).toContain('ADAUSDT');
    expect(ctx.concentrationWarning).toContain('3');
  });

  it('no concentration warning when trades are diverse', () => {
    const history: PairAction[] = [
      { pair: 'BTCUSDT', action: 'LONG', cycle: 10 },
      { pair: 'ETHUSDT', action: 'SHORT', cycle: 9 },
      { pair: 'SOLUSDT', action: 'LONG', cycle: 8 },
      { pair: 'ADAUSDT', action: 'SHORT', cycle: 7 },
    ];
    const ctx = buildDiversityContext(history, pairs, 11);

    expect(ctx.concentrationWarning).toBeUndefined();
  });

  it('ignores HOLD and CLOSE actions for concentration', () => {
    const history: PairAction[] = [
      { pair: 'ADAUSDT', action: 'HOLD', cycle: 10 },
      { pair: 'ADAUSDT', action: 'CLOSE', cycle: 9 },
      { pair: 'BTCUSDT', action: 'LONG', cycle: 8 },
      { pair: 'ETHUSDT', action: 'SHORT', cycle: 7 },
    ];
    const ctx = buildDiversityContext(history, pairs, 11);

    // Only 2 entry actions (LONG, SHORT), spread across pairs
    expect(ctx.concentrationWarning).toBeUndefined();
    expect(ctx.recentPairActions).toHaveLength(2);
  });

  it('limits to lookback window', () => {
    const history: PairAction[] = Array.from({ length: 20 }, (_, i) => ({
      pair: 'ADAUSDT',
      action: 'LONG',
      cycle: 20 - i,
    }));
    const ctx = buildDiversityContext(history, pairs, 21, 5);

    // Only looks at last 5
    expect(ctx.recentPairActions).toHaveLength(5);
  });
});
```

**Run:** `npx vitest run tests/market/pair-diversity.test.ts`
**Expected:** PASS after Step 3.

### Step 5: Implement — Wire pair diversity into TradingLoop

**File:** `src/trading-loop.ts`

**5a. Add import (line 24):**

```typescript
import { buildDiversityContext, type PairAction } from './market/pair-diversity.js';
```

**5b. Add private field to TradingLoop class (after line 88):**

```typescript
private pairDecisionHistory: PairAction[] = [];
```

**5c. After decisions are processed (after the `for (const decision of decisions)` loop ends, around line 1017), record entries:**

```typescript
// Track pair diversity history
for (const decision of decisions) {
  if (decision.action === 'LONG' || decision.action === 'SHORT') {
    this.pairDecisionHistory.push({
      pair: decision.pair,
      action: decision.action,
      cycle: this.cycleCount,
    });
  }
}
// Keep only last 50 entries
if (this.pairDecisionHistory.length > 50) {
  this.pairDecisionHistory = this.pairDecisionHistory.slice(-50);
}
```

**5d. Build diversity context before promptData (around line 497, after pairFilterWarnings):**

```typescript
const diversityContext = buildDiversityContext(
  this.pairDecisionHistory,
  this.deps.pairs,
  this.cycleCount,
);
```

**5e. Add to promptData object (line 498-524):**

```typescript
pairDiversityContext: diversityContext.recentPairActions.length > 0 ? diversityContext : undefined,
```

### Step 6: Implement — Diversity context in prompt

**File:** `src/llm/prompts.ts`

**6a. Add to `EnrichedPromptData` interface:**

```typescript
pairDiversityContext?: {
  recentPairActions: Array<{ pair: string; action: string; cyclesAgo: number }>;
  cyclesSinceLastTrade: Map<string, number>;
  concentrationWarning?: string;
};
```

**6b. Add diversity section in `buildEnrichedPrompt()` (after regime section, before technical analysis, around line 242):**

```typescript
if (data.pairDiversityContext) {
  const div = data.pairDiversityContext;
  prompt += '## Pair Diversity Context\n';

  if (div.recentPairActions.length > 0) {
    prompt += 'Recent entry decisions:\n';
    for (const a of div.recentPairActions.slice(0, 8)) {
      prompt += `  ${a.cyclesAgo} cycle${a.cyclesAgo !== 1 ? 's' : ''} ago: ${a.pair} ${a.action}\n`;
    }
  }

  if (div.cyclesSinceLastTrade.size > 0) {
    prompt += 'Cycles since last entry per pair:\n';
    const sorted = [...div.cyclesSinceLastTrade.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pair, cycles] of sorted) {
      const label = cycles > 20 ? '(never traded)' : cycles <= 2 ? '(RECENT)' : '';
      prompt += `  ${pair}: ${cycles} cycles ${label}\n`;
    }
  }

  if (div.concentrationWarning) {
    prompt += `\n>>> CONCENTRATION WARNING <<<\n`;
    prompt += `${div.concentrationWarning}\n`;
    prompt += `Do NOT fixate on one pair. Spread exposure across the portfolio.\n`;
  }
  prompt += '\n';
}
```

### Step 7: Implement — Relax multi-TF rule in system prompt

**File:** `src/llm/prompts.ts`

Replace multi-TF section in `buildSystemPrompt()` (lines 33-37):

```typescript
MULTI-TIMEFRAME CONFIRMATION:
- LONG: Best if 1h AND 4h trends align bullish (EMA20 > EMA50).
  ALSO ALLOWED if 1h is bullish and 4h is neutral — use reduced leverage (5-8x max).
  If 1h bullish but 4h BEARISH, HOLD.
- SHORT: Best if 1h AND 4h align bearish.
  ALSO ALLOWED if 1h is bearish and 4h is neutral — use reduced leverage (5-8x max).
  If 1h bearish but 4h BULLISH, HOLD.
- 4h trend OPPOSES = hard block. 4h neutral = proceed with caution and lower leverage.
```

### Step 8: Test — Prompt includes diversity section

**File:** `tests/llm/prompts.test.ts` (add to existing or create)

```typescript
describe('buildUserPrompt pair diversity', () => {
  it('includes concentration warning in prompt', () => {
    const data: EnrichedPromptData = {
      snapshots: [],
      indicators: new Map(),
      portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] },
      signals: [],
      news: [],
      fearGreed: { value: 50, label: 'Neutral' },
      pairDiversityContext: {
        recentPairActions: [
          { pair: 'ADAUSDT', action: 'LONG', cyclesAgo: 1 },
          { pair: 'ADAUSDT', action: 'LONG', cyclesAgo: 3 },
          { pair: 'ADAUSDT', action: 'LONG', cyclesAgo: 5 },
        ],
        cyclesSinceLastTrade: new Map([
          ['BTCUSDT', 20],
          ['ETHUSDT', 15],
          ['ADAUSDT', 1],
        ]),
        concentrationWarning: 'You have traded ADAUSDT 3 out of the last 3 entry decisions (100%). Evaluate ALL pairs equally.',
      },
    };

    const prompt = buildUserPrompt(data);

    expect(prompt).toContain('Pair Diversity Context');
    expect(prompt).toContain('ADAUSDT LONG');
    expect(prompt).toContain('CONCENTRATION WARNING');
    expect(prompt).toContain('BTCUSDT: 20 cycles');
    expect(prompt).toContain('Evaluate ALL pairs equally');
  });

  it('omits diversity section when no history', () => {
    const data: EnrichedPromptData = {
      snapshots: [],
      indicators: new Map(),
      portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] },
      signals: [],
      news: [],
      fearGreed: { value: 50, label: 'Neutral' },
    };

    const prompt = buildUserPrompt(data);
    expect(prompt).not.toContain('Pair Diversity');
  });
});
```

**Run:** `npx vitest run tests/llm/prompts.test.ts`
**Expected:** FAIL before Step 6, PASS after.

### Step 9: Test — Multi-TF rule relaxation in system prompt

**File:** `tests/llm/prompts.test.ts`

```typescript
describe('buildSystemPrompt multi-TF relaxation', () => {
  it('allows entry when 1h aligned and 4h neutral', () => {
    const { buildSystemPrompt } = await import('../../src/llm/prompts.js');
    const prompt = buildSystemPrompt({
      targetReturnPct: 100, minTakeProfitPct: 5,
      maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5,
    });

    // Should contain the relaxed rule
    expect(prompt).toContain('ALSO ALLOWED if 1h is bullish and 4h is neutral');
    expect(prompt).toContain('reduced leverage (5-8x max)');
    // Should NOT contain the old strict rule
    expect(prompt).not.toContain('Only if 1h AND 4h trends align bullish');
  });
});
```

**Run:** `npx vitest run tests/llm/prompts.test.ts`
**Expected:** FAIL before Step 7, PASS after.

### Step 10: Verify — Full test suite

**Run:** `npx vitest run tests/`
**Expected:** PASS

### Step 11: Commit

```bash
git add src/market/pair-diversity.ts src/trading-loop.ts src/llm/prompts.ts tests/market/pair-diversity.test.ts tests/llm/prompts.test.ts tests/trading-loop.test.ts
git commit -m "feat(#19): pair fixation fix — diversity prompt, multi-TF relaxation, rotation tracking"
```

## Files Modified

| File | Change |
|------|--------|
| `src/market/pair-diversity.ts` | **NEW** — `buildDiversityContext()` function |
| `src/trading-loop.ts` | Add `pairDecisionHistory` tracking, wire `buildDiversityContext()`, add to promptData |
| `src/llm/prompts.ts` | Add `pairDiversityContext` to `EnrichedPromptData`, inject diversity section + concentration warning, relax multi-TF rule |
| `tests/market/pair-diversity.test.ts` | **NEW** — Unit tests for `buildDiversityContext()` |
| `tests/llm/prompts.test.ts` | Add diversity prompt tests + multi-TF relaxation test |
| `tests/trading-loop.test.ts` | Add pair history tracking test |

## Expected Impact

| Metric | Before | After (Expected) |
|--------|--------|-------------------|
| Pair concentration | 13/16 = 81% one pair | < 40% any single pair |
| Pairs traded | 1 | 3-5 |
| Entry rate | ~2/session (all ADA) | ~4-6/session (diversified) |
| Multi-TF block rate | ~70% (4h neutral blocks) | ~30% (only 4h opposing blocks) |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Too many entries after relaxation | Risk manager still validates; per-pair confluence (Issue #15) still gates |
| LLM ignores diversity context | Concentration warning uses `>>>` emphasis markers; placed before technical analysis |
| Pair history resets on bot restart | Acceptable — fresh start means no fixation bias initially. Could persist to DB later |
| Weaker entries from 4h-neutral trades | System prompt caps these at 5-8x leverage; RiskManager enforces |
| Over-diversification | Concentration warning only triggers at >50%; normal diversification is healthy |

## Dependencies

| Dependency | Status | Required |
|------------|--------|----------|
| Issue #15 (per-pair confluence) | Plan | **YES** — without per-pair confluence, diversity prompt alone won't fix the root cause |
| Issue #16 (swarm reform) | Plan | No — independent, but synergistic |
