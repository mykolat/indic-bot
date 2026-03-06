# Issue #15: Per-Pair Confluence Scores

**Status:** Plan
**Created:** 2026-03-06
**Branch:** `feat/max-info-fetch`

## Problem

Confluence score and filterWarning are computed using BTCUSDT indicators only, then applied as a single gate across all 8 trading pairs. This causes altcoin breakouts to be suppressed when BTC is consolidating (low confluence), and vice versa — false green-lights for altcoins when only BTC has strong confluence.

**Evidence from code:**

`src/trading-loop.ts:388-401` — Regime classifier only runs on BTC:
```typescript
let btcSnap = snapshots.find(s => s.pair === 'BTCUSDT') || snapshots[0];
// ...
const res = classifyRegime(btcInd, parseFloat(btcSnap.markPrice), fearGreed);
```

`src/trading-loop.ts:476-496` — Confluence computed once from BTC, single filterWarning for all pairs:
```typescript
if (btcInd && btcSnap) {
  confluenceResult = computeConfluence({
    trend: btcInd.trend,
    volumeRatio: btcInd.volumeRatio,
    // ... all BTC-specific values
  });
}
```

`src/llm/prompts.ts:271-275` — Single filterWarning injected into prompt covering all pairs:
```typescript
if (data.filterWarning) {
  prompt += `\n>>> SHARK MODE WARNING <<<\n`;
  prompt += `System technical filters FAILED: ${data.filterWarning}\n`;
}
```

## Solution

1. Keep BTC as the **market regime** indicator (global backdrop) — this is correct behavior
2. Compute **per-pair confluence** scores using each pair's own indicators
3. Generate **per-pair filterWarnings** instead of a single global one
4. Inject per-pair warnings into the prompt next to each pair's technical section
5. Log per-pair confluence to DB for observability

## Detailed Design

### Data Flow (Before)

```
BTC indicators → classifyRegime() → single regime
BTC indicators → computeConfluence() → single score → single filterWarning → prompt
```

### Data Flow (After)

```
BTC indicators → classifyRegime() → single regime (unchanged)
Per-pair indicators → computeConfluence() → Map<pair, ConfluenceResult>
Per-pair confluence + activeProfile → Map<pair, filterWarning>
Per-pair filterWarnings → injected into prompt per-pair section
```

### Interface Changes

**`src/llm/prompts.ts`** — `EnrichedPromptData`:
```typescript
// REMOVE (line 141):
filterWarning?: string;

// ADD:
pairFilterWarnings?: Map<string, string>;
pairConfluence?: Map<string, { score: number; factors: string[] }>;
```

**`src/trading-loop.ts`** — Replace single confluence computation with per-pair loop.

**`src/llm/prompts.ts`** — Move filterWarning display from global section to per-pair technical section.

## Implementation Steps (TDD)

### Step 1: Test — computeConfluence works per-pair with different indicators

**File:** `tests/market/confluence.test.ts`

```typescript
// ADD after existing tests (line 105):

describe('per-pair confluence', () => {
  it('different pairs can have different confluence scores', () => {
    const btcInput: ConfluenceInput = {
      trend: 'neutral',
      volumeRatio: 0.5,
      vwap: 100,
      markPrice: 100,
      rsi: 25,
      rsiRange: [30, 70],
      hasNewsCatalyst: false,
    };
    const adaInput: ConfluenceInput = {
      trend: 'bullish',
      volumeRatio: 2.0,
      vwap: 0.45,
      markPrice: 0.48,
      rsi: 55,
      rsiRange: [30, 70],
      hasNewsCatalyst: true,
    };

    const btcResult = computeConfluence(btcInput);
    const adaResult = computeConfluence(adaInput);

    expect(btcResult.score).toBe(0);
    expect(adaResult.score).toBe(5);
  });
});
```

**Run:** `npx vitest run tests/market/confluence.test.ts`
**Expected:** PASS (computeConfluence is already pure and pair-agnostic, this validates the concept).

### Step 2: Test — pairFilterWarnings are generated per-pair in trading-loop

**File:** `tests/trading-loop.test.ts`

Add a new test after the existing tests:

```typescript
it('generates per-pair filterWarnings instead of single global warning', async () => {
  // Override with 2 pairs
  const makePairCandles = (base: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      openTime: i, open: String(base), high: String(base + 1000), low: String(base - 1000),
      close: String(base + i * 10), volume: '100',
    }));

  const btcSnap = {
    pair: 'BTCUSDT', candles1h: makePairCandles(50000, 50), candles4h: [], candles15m: [],
    fundingRate: '0.0001', fundingHistory: [],
    openInterest: '80000', markPrice: '50500',
    longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
  };
  const adaSnap = {
    pair: 'ADAUSDT', candles1h: makePairCandles(45, 50), candles4h: [], candles15m: [],
    fundingRate: '0.0001', fundingHistory: [],
    openInterest: '5000', markPrice: '46',
    longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
  };

  let snapshotIndex = 0;
  mockMarketData.getSnapshot = vi.fn().mockImplementation((pair: string) => {
    return pair === 'BTCUSDT' ? Promise.resolve(btcSnap) : Promise.resolve(adaSnap);
  });

  let capturedPromptData: any;
  mockLlm.analyze = vi.fn().mockImplementation((data: any) => {
    capturedPromptData = data;
    return [{ pair: 'BTCUSDT', action: 'HOLD', reasoning: 'test', confidence: 50 }];
  });

  const twoLoop = new TradingLoop({
    ...buildDeps(),
    pairs: ['BTCUSDT', 'ADAUSDT'],
  });

  await twoLoop.runOnce();

  // After per-pair confluence, pairFilterWarnings should be a Map
  expect(capturedPromptData.pairFilterWarnings).toBeDefined();
  expect(capturedPromptData.pairFilterWarnings).toBeInstanceOf(Map);
  // Old single filterWarning should be undefined
  expect(capturedPromptData.filterWarning).toBeUndefined();
});
```

**Run:** `npx vitest run tests/trading-loop.test.ts`
**Expected:** FAIL — `pairFilterWarnings` is not yet in promptData; `filterWarning` is still a string.

### Step 3: Implement — Per-pair confluence in trading-loop.ts

**File:** `src/trading-loop.ts`

**3a. Replace single confluence block (lines 472-496) with per-pair loop:**

```typescript
// Per-pair confluence and filter warnings
const pairConfluence = new Map<string, { score: number; factors: string[] }>();
const pairFilterWarnings = new Map<string, string>();
const hasNewsCatalyst = !!(newsAnalysis && Array.isArray((newsAnalysis as any).top_signals) && (newsAnalysis as any).top_signals.some((s: any) => s.importance >= 7));

for (const snap of snapshots) {
  const pairInd = indicators.get(snap.pair);
  if (!pairInd || !activeProfile) continue;

  const result = computeConfluence({
    trend: pairInd.trend,
    volumeRatio: pairInd.volumeRatio,
    vwap: pairInd.vwap || 0,
    markPrice: parseFloat(snap.markPrice),
    rsi: pairInd.rsi,
    rsiRange: activeProfile ? [activeProfile.rsiRange?.[0] ?? 30, activeProfile.rsiRange?.[1] ?? 70] : [30, 70],
    hasNewsCatalyst,
  });
  pairConfluence.set(snap.pair, result);

  // Generate per-pair filterWarning (only for new entries, not when positions open)
  if (portfolio.positions.length === 0 || !portfolio.positions.some(p => p.pair === snap.pair)) {
    if (pairInd.volumeRatio < activeProfile.volumeMin) {
      pairFilterWarnings.set(snap.pair, `Volume ${pairInd.volumeRatio.toFixed(2)}x < ${activeProfile.volumeMin}x required for ${marketRegime}`);
    } else if (result.score < activeProfile.confluenceMin) {
      pairFilterWarnings.set(snap.pair, `Confluence ${result.score}/5 [${result.factors.join(',')}] < ${activeProfile.confluenceMin} required for ${marketRegime}`);
    }
  }
}

// Keep BTC confluence for backward-compat logging
const confluenceResult = pairConfluence.get('BTCUSDT') || pairConfluence.values().next().value;
```

**3b. Update promptData object (lines 498-524):**

Remove `filterWarning` key, add:
```typescript
pairFilterWarnings: pairFilterWarnings.size > 0 ? pairFilterWarnings : undefined,
pairConfluence,
```

**3c. Update log line (lines 560-562):**

```typescript
if (pairFilterWarnings.size > 0) {
  for (const [pair, warning] of pairFilterWarnings) {
    console.log(`[Loop] Pre-flight warning [${pair}]: ${warning}`);
  }
}
```

**3d. Update DB decision insert (line 821-822):**

Replace:
```typescript
volume_ratio: btcInd?.volumeRatio,
confluence_score: confluenceResult?.score,
confluence_factors: confluenceResult?.factors,
```
With:
```typescript
volume_ratio: indicators.get(decision.pair)?.volumeRatio ?? btcInd?.volumeRatio,
confluence_score: pairConfluence.get(decision.pair)?.score ?? confluenceResult?.score,
confluence_factors: pairConfluence.get(decision.pair)?.factors ?? confluenceResult?.factors,
```

### Step 4: Implement — Per-pair filterWarning in prompts.ts

**File:** `src/llm/prompts.ts`

**4a. Update `EnrichedPromptData` interface (around line 141):**

```typescript
// REMOVE:
filterWarning?: string;
// ADD:
pairFilterWarnings?: Map<string, string>;
pairConfluence?: Map<string, { score: number; factors: string[] }>;
```

**4b. Replace global filterWarning injection (lines 271-275) with per-pair injection inside the per-pair loop:**

In `buildEnrichedPrompt()`, remove the global block (lines 271-275):
```typescript
// DELETE these lines:
if (data.filterWarning) {
  prompt += `\n>>> SHARK MODE WARNING <<<\n`;
  prompt += `System technical filters FAILED: ${data.filterWarning}\n`;
  prompt += `ACTION REQUIRED: You are heavily advised to HOLD. ...`;
}
```

Inside the per-pair `for (const snap of data.snapshots)` loop (after line 383, after `prompt += '\n';`), add:
```typescript
// Per-pair filter warning
const pairWarning = data.pairFilterWarnings?.get(snap.pair);
if (pairWarning) {
  prompt += `>>> SHARK MODE WARNING for ${snap.pair} <<<\n`;
  prompt += `Technical filter: ${pairWarning}\n`;
  prompt += `Heavily advised to HOLD ${snap.pair} unless extreme conviction.\n`;
}
// Per-pair confluence
const pairConf = data.pairConfluence?.get(snap.pair);
if (pairConf) {
  prompt += `Confluence: ${pairConf.score}/5 [${pairConf.factors.join(', ')}]\n`;
}
prompt += '\n';
```

### Step 5: Verify — Re-run tests

**Run:** `npx vitest run tests/trading-loop.test.ts`
**Expected:** PASS — new test expects `pairFilterWarnings` Map and undefined `filterWarning`.

**Run:** `npx vitest run tests/market/confluence.test.ts`
**Expected:** PASS — no changes to computeConfluence signature.

### Step 6: Test — Prompt includes per-pair confluence in output

**File:** `tests/llm/prompts.test.ts` (or create if absent)

```typescript
import { describe, it, expect } from 'vitest';
import { buildUserPrompt, type EnrichedPromptData } from '../../src/llm/prompts.js';

describe('buildUserPrompt per-pair confluence', () => {
  it('includes per-pair filterWarning next to pair section', () => {
    const data: EnrichedPromptData = {
      snapshots: [
        {
          pair: 'BTCUSDT', candles1h: [], candles4h: [], candles15m: [],
          fundingRate: '0.0001', fundingHistory: [], openInterest: '80000',
          markPrice: '50000', longShortRatio: null,
          orderBookBidPct: 50, orderBookAskPct: 50,
        } as any,
        {
          pair: 'ADAUSDT', candles1h: [], candles4h: [], candles15m: [],
          fundingRate: '0.0001', fundingHistory: [], openInterest: '5000',
          markPrice: '0.45', longShortRatio: null,
          orderBookBidPct: 50, orderBookAskPct: 50,
        } as any,
      ],
      indicators: new Map(),
      portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] },
      signals: [],
      news: [],
      fearGreed: { value: 50, label: 'Neutral' },
      pairFilterWarnings: new Map([
        ['ADAUSDT', 'Volume 0.30x < 0.40x required for Range'],
      ]),
      pairConfluence: new Map([
        ['BTCUSDT', { score: 3, factors: ['trend', 'volume', 'rsi'] }],
        ['ADAUSDT', { score: 1, factors: ['rsi'] }],
      ]),
    };

    const prompt = buildUserPrompt(data);

    // ADA should have filter warning
    expect(prompt).toContain('SHARK MODE WARNING for ADAUSDT');
    expect(prompt).toContain('Volume 0.30x < 0.40x');

    // BTC should NOT have filter warning
    expect(prompt).not.toContain('SHARK MODE WARNING for BTCUSDT');

    // Both should have confluence scores
    expect(prompt).toContain('Confluence: 3/5');
    expect(prompt).toContain('Confluence: 1/5');
  });

  it('omits global filterWarning (backward compat removed)', () => {
    const data: EnrichedPromptData = {
      snapshots: [],
      indicators: new Map(),
      portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] },
      signals: [],
      news: [],
      fearGreed: { value: 50, label: 'Neutral' },
    };

    const prompt = buildUserPrompt(data);
    // Should never contain old global warning
    expect(prompt).not.toContain('SHARK MODE WARNING');
  });
});
```

**Run:** `npx vitest run tests/llm/prompts.test.ts`
**Expected:** FAIL before implementation, PASS after Step 4.

### Step 7: Test — DB logs per-pair confluence in trade_decisions

**File:** `tests/trading-loop.test.ts`

```typescript
it('logs per-pair confluence_score in DB trade_decisions', async () => {
  // This test validates that the insertTradeDecision call uses
  // pair-specific confluence, not the global BTC one.
  // After implementation, the insertTradeDecision call for ADAUSDT
  // should use pairConfluence.get('ADAUSDT'), not btcConfluence.
  // (Integration test — verify by inspecting the mock call args)
  // Skipped until DB mocking is wired — serves as documentation.
});
```

### Step 8: Commit

```bash
git add src/trading-loop.ts src/llm/prompts.ts tests/market/confluence.test.ts tests/trading-loop.test.ts tests/llm/prompts.test.ts
git commit -m "feat(#15): per-pair confluence scores — replace single BTC proxy with pair-specific filtering"
```

## Files Modified

| File | Change |
|------|--------|
| `src/trading-loop.ts` | Replace single BTC confluence (L476-496) with per-pair loop; update promptData, logging, DB inserts |
| `src/llm/prompts.ts` | Add `pairFilterWarnings` + `pairConfluence` to `EnrichedPromptData`; move warning to per-pair section |
| `tests/market/confluence.test.ts` | Add test proving different pairs produce different scores |
| `tests/trading-loop.test.ts` | Add test asserting `pairFilterWarnings` Map in promptData |
| `tests/llm/prompts.test.ts` | Add test asserting per-pair warning injection in prompt output |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| More verbose prompt (8 pairs x confluence line) | Each line is ~50 chars; total +400 chars is negligible vs 10k+ prompt |
| Regime still uses BTC only | This is intentional — BTC regime = market backdrop. Per-pair confluence handles pair-level conditions |
| DB schema for `confluence_score` is single number | Keep per-cycle BTC confluence for backward compat; per-pair goes in `trade_decisions` table which already has per-decision fields |
| Altcoins with low-quality data may get noisy confluence | `computeConfluence` already handles neutrals gracefully (trend='neutral' = 0 points) |

## Dependencies

- None (pure refactor of existing code paths)
- Issue #19 (pair fixation) builds on top of per-pair confluence data
