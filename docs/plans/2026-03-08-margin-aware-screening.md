# Margin-Aware Pre-Screening — Implementation Plan

**Goal:** Stop wasting LLM tokens when margin is exhausted. Three modes based on available balance: normal, low-margin (micro-position with 2x leverage), no-margin (algorithmic SL/TP + hourly LLM for open positions only).

**Architecture:** PreScreener gains `MarginContext` input. TradingLoop passes available balance info. Envelope and prompt adapt per margin mode.

---

## Task 1: Add MarginContext to PreScreener + Tests

**Files:**
- Modify: `src/market/pre-screener.ts`
- Modify: `tests/market/pre-screener.test.ts`

**Step 1: Add MarginContext interface and marginMode to ScreenAllResult**

In `src/market/pre-screener.ts`, add:

```typescript
export type MarginMode = 'normal' | 'low_margin' | 'no_margin';

export interface MarginContext {
  availableUsd: number;
  walletBalanceUsd: number;
  minPositionUsd: number; // from Binance exchangeInfo, typically 5-10 USDT
}
```

Add `marginMode` to `ScreenAllResult`:
```typescript
export interface ScreenAllResult {
  passed: ScreenVerdict[];
  held: ScreenVerdict[];
  marginMode: MarginMode;
}
```

**Step 2: Update `screenAll()` to accept MarginContext**

```typescript
screenAll(inputs: ScreenInput[], opts?: { exposureFull?: boolean; margin?: MarginContext }): ScreenAllResult {
  // Determine margin mode
  let marginMode: MarginMode = 'normal';
  if (opts?.margin) {
    const { availableUsd, walletBalanceUsd, minPositionUsd } = opts.margin;
    if (availableUsd < minPositionUsd) {
      marginMode = 'no_margin';
    } else if (availableUsd < walletBalanceUsd * 0.1) {
      marginMode = 'low_margin';
    }
  }

  const passed: ScreenVerdict[] = [];
  const held: ScreenVerdict[] = [];

  for (const input of inputs) {
    // No margin: only positions + BTC
    if (marginMode === 'no_margin' && !input.hasPosition && input.pair !== 'BTCUSDT') {
      held.push({ pair: input.pair, verdict: 'hold', reason: 'no_margin' });
      continue;
    }

    // Existing exposureFull check
    if (opts?.exposureFull && !input.hasPosition) {
      held.push({ pair: input.pair, verdict: 'hold', reason: 'exposure_full' });
      continue;
    }

    const result = this.screen(input);
    if (result.verdict === 'hold') {
      held.push(result);
    } else {
      passed.push(result);
    }
  }

  // Safety: min 1 pair
  if (passed.length === 0 && held.length > 0) {
    const forced = held.shift()!;
    passed.push({ ...forced, verdict: 'pass' });
  }

  return { passed, held, marginMode };
}
```

**Step 3: Write tests**

Add to `tests/market/pre-screener.test.ts`:

```typescript
describe('margin modes', () => {
  it('no_margin: only passes positions + BTC', () => {
    const results = screener.screenAll([
      { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
      { pair: 'ETHUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: true },
      { pair: 'SOLUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
    ], { margin: { availableUsd: 3, walletBalanceUsd: 187, minPositionUsd: 5 } });
    expect(results.marginMode).toBe('no_margin');
    expect(results.passed.map(p => p.pair)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(results.held).toHaveLength(1);
    expect(results.held[0].reason).toBe('no_margin');
  });

  it('low_margin: passes all filtered pairs (LLM picks best)', () => {
    const results = screener.screenAll([
      { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
      { pair: 'ETHUSDT', ind1h: makeInd({ volumeRatio: 0.1 }), ind4h: makeInd(), regime: 'Range', confluence: 0, hasPosition: false },
    ], { margin: { availableUsd: 15, walletBalanceUsd: 187, minPositionUsd: 5 } });
    expect(results.marginMode).toBe('low_margin');
    expect(results.passed).toHaveLength(1); // BTC passes, ETH held by filters
  });

  it('normal mode when margin sufficient', () => {
    const results = screener.screenAll([
      { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
    ], { margin: { availableUsd: 100, walletBalanceUsd: 187, minPositionUsd: 5 } });
    expect(results.marginMode).toBe('normal');
  });
});
```

**Step 4: Run tests**
`npx vitest run tests/market/pre-screener.test.ts` — all pass

**Step 5: Commit**
```bash
git add src/market/pre-screener.ts tests/market/pre-screener.test.ts
git commit -m "feat(pre-screen): margin-aware modes — normal/low_margin/no_margin"
```

---

## Task 2: Wire MarginContext into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts`

**Step 1: Pass MarginContext to PreScreener**

In `runOnce()`, where `screenAll()` is called, add margin context:

```typescript
screenResult = this.deps.preScreener.screenAll(screenInputs, {
  exposureFull,
  margin: {
    availableUsd: portfolio.availableUsd ?? portfolio.balanceUsd,
    walletBalanceUsd: portfolio.balanceUsd,
    minPositionUsd: 6, // safe default above Binance min notional
  },
});
```

**Step 2: Log margin mode**

After screenResult, add:
```typescript
if (screenResult.marginMode !== 'normal') {
  console.log(`[PreScreen] Margin mode: ${screenResult.marginMode} (available: $${(portfolio.availableUsd ?? portfolio.balanceUsd).toFixed(2)})`);
}
```

**Step 3: Run tests**
`npx vitest run tests/` — all pass

**Step 4: Commit**
```bash
git add src/trading-loop.ts
git commit -m "feat(loop): pass MarginContext to PreScreener"
```

---

## Task 3: Leverage 2x in Low-Margin Mode

**Files:**
- Modify: `src/trading-loop.ts`

**Step 1: Double envelope leverage in low_margin mode**

After `computeEnvelope()` and after screenResult is available, add:

```typescript
if (screenResult?.marginMode === 'low_margin' && envelope) {
  envelope.maxLeverage = Math.min(envelope.maxLeverage * 2, this.deps.tradingConfig.maxLeverage);
  envelope.recommendedLeverage = [
    envelope.recommendedLeverage[0] * 2,
    Math.min(envelope.recommendedLeverage[1] * 2, envelope.maxLeverage),
  ];
  console.log(`[PreScreen] Low margin — leverage doubled: max ${envelope.maxLeverage}x`);
}
```

**Step 2: Run tests**
`npx vitest run tests/` — all pass

**Step 3: Commit**
```bash
git add src/trading-loop.ts
git commit -m "feat(loop): double leverage in low-margin mode"
```

---

## Task 4: Low-Margin Prompt Block

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `src/trading-loop.ts` (pass marginMode to promptData)

**Step 1: Add marginMode to promptData**

In `src/trading-loop.ts`, add to promptData:
```typescript
marginMode: screenResult?.marginMode,
```

**Step 2: Add prompt block in buildEnrichedPrompt**

In `src/llm/prompts.ts`, after the envelope section, add:

```typescript
if ((data as any).marginMode === 'low_margin') {
  const avail = (data.portfolio.availableUsd ?? data.portfolio.balanceUsd).toFixed(2);
  prompt += `## LOW MARGIN MODE\n`;
  prompt += `Available margin: $${avail}. Pick at most 1 new position. Leverage is doubled to compensate small margin. Be highly selective.\n\n`;
}
```

**Step 3: Run tests**
`npx vitest run tests/` — all pass

**Step 4: Commit**
```bash
git add src/trading-loop.ts src/llm/prompts.ts
git commit -m "feat(prompts): low-margin mode prompt block"
```

---

## Task 5: No-Margin Cycle Floor (60 min)

**Files:**
- Modify: `src/trading-loop.ts`

**Step 1: Override nextCheckMinutes in no_margin mode**

After existing `nextCheckMinutes` logic (where floors are applied), add:

```typescript
if (screenResult?.marginMode === 'no_margin' && nextCheckMinutes < 60) {
  nextCheckMinutes = 60;
  console.log(`[PreScreen] No margin — cycle floor 60 min`);
}
```

**Step 2: Run tests**
`npx vitest run tests/` — all pass

**Step 3: Commit**
```bash
git add src/trading-loop.ts
git commit -m "feat(loop): 60-min cycle floor in no-margin mode"
```

---

## Task Dependency Graph

```
Task 1 (MarginContext + tests)
    └─→ Task 2 (Wire into loop)
         ├─→ Task 3 (Leverage 2x)
         ├─→ Task 4 (Prompt block)
         └─→ Task 5 (Cycle floor)
```

Tasks 3, 4, 5 are independent after Task 2.

---

## Verification Checklist

- [ ] `npx vitest run` — all tests pass
- [ ] `npm run build` — no new errors
- [ ] Deploy: `npm run deploy`
- [ ] Check pm2 logs for `[PreScreen] Margin mode:` messages
- [ ] When positions open + low margin: verify leverage doubled in decisions
- [ ] When no margin: verify 60-min cycle floor + only positions + BTC in LLM
