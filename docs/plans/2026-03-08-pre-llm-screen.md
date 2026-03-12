# Pre-LLM Screening Layer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop wasting 12K+ tokens per cycle on pairs where the outcome is an obvious algorithmic HOLD. Pre-screen pairs before LLM, send only actionable ones. Estimated 70-80% token reduction on quiet cycles.

**Architecture:** New `PreScreener` class runs after indicators are computed but before LLM call. Each pair gets a `ScreenVerdict`: `pass` (send to LLM), `hold` (auto-HOLD with reason slug), or `manage` (has open position — always send). Only passed/managed pairs go into `promptData.snapshots`. Auto-HOLD pairs get synthetic `TradeDecision[]` entries merged back after LLM returns. This is a hard filter — LLM never sees rejected pairs.

**Tech Stack:** TypeScript ESM (.js imports), Vitest, existing `Indicators` + `FilterProfile` types.

**Depends on:** Phase 1 (Remove Fragility) — completed.

---

## Task 1: PreScreener — Core Logic + Tests

**Files:**
- Create: `src/market/pre-screener.ts`
- Test: `tests/market/pre-screener.test.ts`

**Context:** The screener needs access to: 1h indicators, 4h indicators, per-pair regime/profile, open positions, and per-pair confluence. It returns a verdict per pair.

**Step 1: Write the failing test**

```typescript
// tests/market/pre-screener.test.ts
import { describe, it, expect } from 'vitest';
import { PreScreener, type ScreenVerdict } from '../../src/market/pre-screener.js';

const makeInd = (overrides: Partial<any> = {}) => ({
  rsi: 50, ema20: 100, ema50: 99, trend: 'bullish' as const,
  volumeRatio: 1.0, vwap: 100, adx: 30,
  macd: 0, macdSignal: 0, macdHistogram: 0,
  bollingerUpper: 110, bollingerMiddle: 100, bollingerLower: 90,
  bollingerBandwidth: 20, bollingerPercentB: 50, atr: 2,
  ...overrides,
});

describe('PreScreener', () => {
  const screener = new PreScreener();

  it('passes pair with open position regardless of indicators', () => {
    const result = screener.screen({
      pair: 'BTCUSDT',
      ind1h: makeInd({ volumeRatio: 0.1, trend: 'neutral' }),
      ind4h: makeInd({ trend: 'neutral' }),
      regime: 'Range',
      confluence: 0,
      hasPosition: true,
    });
    expect(result.verdict).toBe('manage');
  });

  it('holds pair when 1h and 4h trends conflict for SHORT', () => {
    const result = screener.screen({
      pair: 'ETHUSDT',
      ind1h: makeInd({ trend: 'bearish' }),
      ind4h: makeInd({ trend: 'bullish' }),
      regime: 'BearTrend',
      confluence: 3,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('4h_conflict');
  });

  it('holds pair when volume below regime minimum', () => {
    const result = screener.screen({
      pair: 'SOLUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 0.3 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 2,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('low_volume');
  });

  it('holds pair when RSI out of regime range (oversold in BearTrend)', () => {
    const result = screener.screen({
      pair: 'BNBUSDT',
      ind1h: makeInd({ trend: 'bearish', rsi: 18, volumeRatio: 1.0 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 2,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('rsi_extreme');
  });

  it('holds pair when confluence below regime minimum', () => {
    const result = screener.screen({
      pair: 'XRPUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 1.0, rsi: 40 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 1,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('low_confluence');
  });

  it('holds pair with no usable data', () => {
    const result = screener.screen({
      pair: 'PEPEUSDT',
      ind1h: null,
      ind4h: null,
      regime: 'Range',
      confluence: 0,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('no_data');
  });

  it('passes pair when all checks pass', () => {
    const result = screener.screen({
      pair: 'LTCUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 1.2, rsi: 40 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 3,
      hasPosition: false,
    });
    expect(result.verdict).toBe('pass');
  });

  it('passes pair in Capitulation (permissive filters)', () => {
    const result = screener.screen({
      pair: 'AVAXUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 0.5, rsi: 25 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'Capitulation',
      confluence: 1,
      hasPosition: false,
    });
    expect(result.verdict).toBe('pass');
  });

  it('screenAll returns categorized results', () => {
    const results = screener.screenAll([
      { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: true },
      { pair: 'ETHUSDT', ind1h: makeInd({ volumeRatio: 0.1 }), ind4h: makeInd(), regime: 'Range', confluence: 0, hasPosition: false },
    ]);
    expect(results.passed).toHaveLength(1);
    expect(results.passed[0].pair).toBe('BTCUSDT');
    expect(results.held).toHaveLength(1);
    expect(results.held[0].pair).toBe('ETHUSDT');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/pre-screener.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/market/pre-screener.ts
import { getFilterProfile, type FilterProfile } from './filter-profiles.js';
import type { MarketRegime } from './regime-classifier.js';

export interface ScreenInput {
  pair: string;
  ind1h: any | null;   // Indicators type
  ind4h: any | null;
  regime: string;
  confluence: number;
  hasPosition: boolean;
}

export interface ScreenVerdict {
  pair: string;
  verdict: 'pass' | 'hold' | 'manage';
  reason?: string;
}

export interface ScreenAllResult {
  passed: ScreenVerdict[];   // pass + manage — send to LLM
  held: ScreenVerdict[];     // auto-HOLD — skip LLM
}

export class PreScreener {
  screen(input: ScreenInput): ScreenVerdict {
    const { pair, ind1h, ind4h, regime, confluence, hasPosition } = input;

    // Always send pairs with open positions
    if (hasPosition) {
      return { pair, verdict: 'manage' };
    }

    // No data → can't trade
    if (!ind1h) {
      return { pair, verdict: 'hold', reason: 'no_data' };
    }

    const profile = getFilterProfile(regime as MarketRegime);
    if (!profile) {
      return { pair, verdict: 'pass' }; // unknown regime → let LLM decide
    }

    // 4h trend conflict: 1h says one thing, 4h says opposite
    if (ind4h && ind1h.trend !== 'neutral' && ind4h.trend !== 'neutral' && ind1h.trend !== ind4h.trend) {
      return { pair, verdict: 'hold', reason: '4h_conflict' };
    }

    // Volume below regime minimum
    if (ind1h.volumeRatio < profile.volumeMin) {
      return { pair, verdict: 'hold', reason: 'low_volume' };
    }

    // RSI outside regime range
    if (ind1h.rsi < profile.rsiRange[0] || ind1h.rsi > profile.rsiRange[1]) {
      return { pair, verdict: 'hold', reason: 'rsi_extreme' };
    }

    // Confluence below regime minimum
    if (confluence < profile.confluenceMin) {
      return { pair, verdict: 'hold', reason: 'low_confluence' };
    }

    return { pair, verdict: 'pass' };
  }

  screenAll(inputs: ScreenInput[]): ScreenAllResult {
    const passed: ScreenVerdict[] = [];
    const held: ScreenVerdict[] = [];

    for (const input of inputs) {
      const result = this.screen(input);
      if (result.verdict === 'hold') {
        held.push(result);
      } else {
        passed.push(result);
      }
    }

    return { passed, held };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/market/pre-screener.test.ts`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add src/market/pre-screener.ts tests/market/pre-screener.test.ts
git commit -m "feat(market): add PreScreener — algorithmic pair filtering before LLM"
```

---

## Task 2: Wire PreScreener into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts:698-788` (after indicators, before promptData)
- Modify: `src/trading-loop.ts:40-90` (TradingLoopDeps — add preScreener)
- Modify: `src/index.ts` (instantiate PreScreener)

**Step 1: Read current code**

Read `src/trading-loop.ts` lines 698-790 and `src/index.ts` to understand current flow.

**Step 2: Add PreScreener to deps**

In `src/trading-loop.ts`, import and add to `TradingLoopDeps`:

```typescript
import { PreScreener } from './market/pre-screener.js';
```

Add to interface (after `tradingConfig`):
```typescript
  preScreener?: PreScreener;
```

**Step 3: Insert screening after confluence computation (line ~730)**

After the existing confluence loop (line 719) and before `promptData` assembly (line 754), add:

```typescript
// Pre-LLM screening: filter pairs algorithmically
const openPairSet = new Set(portfolio.positions.map(p => p.pair));
let screenResult: import('./market/pre-screener.js').ScreenAllResult | undefined;
let filteredSnapshots = snapshots;

if (this.deps.preScreener) {
  const screenInputs = snapshots.map(snap => ({
    pair: snap.pair,
    ind1h: indicators.get(snap.pair) ?? null,
    ind4h: indicators4h.get(snap.pair) ?? null,
    regime: pairRegimes.get(snap.pair)?.regime ?? marketRegime,
    confluence: pairConfluence.get(snap.pair)?.score ?? 0,
    hasPosition: openPairSet.has(snap.pair),
  }));
  screenResult = this.deps.preScreener.screenAll(screenInputs);

  // Only send passed/managed pairs to LLM
  const passedPairs = new Set(screenResult.passed.map(v => v.pair));
  filteredSnapshots = snapshots.filter(s => passedPairs.has(s.pair));

  if (screenResult.held.length > 0) {
    const heldSummary = screenResult.held.map(h => `${h.pair}:${h.reason}`).join(', ');
    console.log(`[PreScreen] ${screenResult.held.length} pairs auto-HOLD: ${heldSummary}`);
    console.log(`[PreScreen] ${filteredSnapshots.length}/${snapshots.length} pairs sent to LLM`);
  }
}
```

**Step 4: Use filteredSnapshots in promptData**

Change line 755 from:
```typescript
snapshots,
```
to:
```typescript
snapshots: filteredSnapshots,
```

**Step 5: Merge auto-HOLD decisions back after LLM returns**

After line 844 (after `decisions = await llm.analyze(promptData)` or swarm), add:

```typescript
// Merge auto-HOLD decisions from pre-screener
if (screenResult?.held.length) {
  for (const held of screenResult.held) {
    decisions.push({
      pair: held.pair,
      action: 'HOLD',
      size_pct: 0,
      leverage: 0,
      stop_loss_pct: 0,
      take_profit_pct: 0,
      reasoning: held.reason ?? 'pre_screen',
      confidence: 0,
    });
  }
}
```

**Step 6: Instantiate in index.ts**

In `src/index.ts`, import and create:
```typescript
import { PreScreener } from './market/pre-screener.js';
```

Add to TradingLoop constructor deps:
```typescript
preScreener: new PreScreener(),
```

**Step 7: Run existing tests**

Run: `npx vitest run tests/`
Expected: All tests pass (PreScreener is optional via `?`)

**Step 8: Commit**

```bash
git add src/trading-loop.ts src/index.ts
git commit -m "feat(loop): wire PreScreener — filter pairs before LLM call"
```

---

## Task 3: Log Pre-Screen Results to DB

**Files:**
- Modify: `src/trading-loop.ts` (log screening stats to cycle record)
- Modify: `src/db/repository.ts` (if needed — check if cycles table has room for extra fields)

**Step 1: Read DB schema for cycles table**

Check `src/db/repository.ts` for `insertCycle` and what fields cycles takes. We want to record `pairs_screened`, `pairs_passed`, `pairs_held` per cycle.

**Step 2: Add screening stats to performance log**

In `src/trading-loop.ts`, find the performance logging section (search for `logPerformance` or `performance.jsonl`). Add pre-screen stats:

```typescript
preScreen: screenResult ? {
  total: screenResult.passed.length + screenResult.held.length,
  passed: screenResult.passed.length,
  held: screenResult.held.length,
  heldReasons: screenResult.held.reduce((acc, h) => {
    acc[h.reason ?? 'unknown'] = (acc[h.reason ?? 'unknown'] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>),
} : undefined,
```

**Step 3: Run tests**

Run: `npx vitest run tests/`
Expected: All pass

**Step 4: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat(loop): log pre-screen stats to performance log"
```

---

## Task 4: Safety — Always Send BTC to LLM

**Files:**
- Modify: `src/market/pre-screener.ts` (BTC bypass)
- Test: `tests/market/pre-screener.test.ts`

**Context:** BTC is the market barometer. Even if its filters fail, LLM should always see BTC data for macro context. Also, we should always send at least 1 pair to avoid empty LLM calls.

**Step 1: Write the failing test**

Add to `tests/market/pre-screener.test.ts`:

```typescript
it('always passes BTC even if filters fail', () => {
  const result = screener.screen({
    pair: 'BTCUSDT',
    ind1h: makeInd({ trend: 'bearish', volumeRatio: 0.1 }),
    ind4h: makeInd({ trend: 'bullish' }),
    regime: 'Range',
    confluence: 0,
    hasPosition: false,
  });
  expect(result.verdict).toBe('pass');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/pre-screener.test.ts -t "always passes BTC"`
Expected: FAIL — returns 'hold'

**Step 3: Add BTC bypass at top of `screen()` method**

After the `hasPosition` check, add:

```typescript
// BTC always passes — market barometer
if (pair === 'BTCUSDT') {
  return { pair, verdict: 'pass' };
}
```

**Step 4: Add minimum-1-pair guard in `screenAll()`**

In `screenAll()`, after the loop, add:

```typescript
// Safety: if nothing passed, force first pair through
if (passed.length === 0 && held.length > 0) {
  const forced = held.shift()!;
  passed.push({ ...forced, verdict: 'pass' });
}
```

**Step 5: Run tests**

Run: `npx vitest run tests/market/pre-screener.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/market/pre-screener.ts tests/market/pre-screener.test.ts
git commit -m "fix(pre-screen): always pass BTC + minimum 1 pair guard"
```

---

## Task 5: Update Prompt to Show Screened-Out Pairs Summary

**Files:**
- Modify: `src/llm/prompts.ts:208-667` (add screened-out summary to prompt)
- Modify: `src/trading-loop.ts` (pass screening results to promptData)

**Context:** LLM should know which pairs were filtered and why — provides macro context without full data dump. One line per filtered pair instead of full technical block.

**Step 1: Add `screenedOutPairs` to promptData**

In `src/trading-loop.ts`, add to `promptData` object:

```typescript
screenedOutPairs: screenResult?.held.map(h => ({ pair: h.pair, reason: h.reason ?? 'unknown' })),
```

**Step 2: Add summary block in buildEnrichedPrompt**

In `src/llm/prompts.ts`, before the main `for (const snap of data.snapshots)` loop (line 349), add:

```typescript
// Pre-screened pairs (auto-HOLD by algorithmic filter)
if ((data as any).screenedOutPairs?.length) {
  prompt += `\n## PRE-SCREENED (auto-HOLD)\n`;
  prompt += `These pairs failed algorithmic filters — output HOLD with the reason slug:\n`;
  for (const sp of (data as any).screenedOutPairs) {
    prompt += `- ${sp.pair}: ${sp.reason}\n`;
  }
  prompt += `\n`;
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/llm/prompts.ts src/trading-loop.ts
git commit -m "feat(prompts): add screened-out pairs summary to LLM context"
```

---

## Task Dependency Graph

```
Task 1 (PreScreener core)
    └─→ Task 2 (Wire into loop)
         ├─→ Task 3 (DB logging)
         └─→ Task 5 (Prompt update)
    └─→ Task 4 (BTC bypass + safety)
```

**Parallel-safe groups:**
- Group A: Task 1 → Task 4 (core + safety)
- Group B: Tasks 2, 3, 5 (wiring — sequential)

Recommended order: 1 → 4 → 2 → 3 → 5

---

## Verification Checklist

After all 5 tasks complete:

- [ ] `npx vitest run` — all tests pass
- [ ] `npm run build` — no new errors (pre-existing OK)
- [ ] Deploy to GCP VM: `npm run deploy`
- [ ] Check pm2 logs for `[PreScreen]` messages
- [ ] Verify token reduction: compare `tokens.jsonl` before/after (~70% fewer tokens on quiet cycles)
- [ ] Verify BTC always appears in LLM decisions
- [ ] Verify open positions always managed (not auto-HOLDed)
- [ ] `config.yaml` — no new config needed (uses existing filter-profiles)
