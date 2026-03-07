# Rounds 7-9: Intelligence Reform + SL/TP + Dashboard

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close remaining 9 issues (#2-#6, #8, #16, #18, #19) — swarm efficiency, flash-crash reliability, pair diversity, regime-aware SL/TP, and full dashboard.

**Architecture:** 9 issues reorganized into 7 tasks across 4 batches. New standalone modules first, then integration wiring. Dashboard issues (#2-#6) consolidated into 2 tasks (data layer + endpoint).

**Tech Stack:** TypeScript ESM (`.js` imports), Vitest, Binance Futures API, xAI Grok, Express

---

## Pre-flight

- **Branch:** `feat/max-info-fetch`
- **Baseline:** 287/287 tests pass (41 files)
- **Completed this session:** #7, #9, #11, #13, #14, #15, #17
- **Key rules:** ESM `.js` imports, vitest, `submitNewAlgoOrder` with `triggerPrice`, never read `.env`
- **Binance client methods available:** `getKlines`, `getMarkPrice`, `getOpenInterest`, `getBalance`, `getPositions`, `getAccountInformation`, `getIncome`, `getOrderBook`, `getFundingRateHistory`, `getTopTradersLongShortPositionRatio`

## File Conflict Map

| File | Issues | Batch |
|------|--------|-------|
| `src/market/pair-diversity.ts` | #19 (new) | 1 |
| `src/market/sl-tp-styles.ts` | #8 (new) | 1 |
| `src/llm/swarm-agent.ts` | #16 | 2 |
| `src/news/flash-crash.ts` | #18 | 2 |
| `src/binance/market-data.ts` | #18, #2-#6 | 2→3 |
| `src/risk/manager.ts` | #2, #3, #4, #6 | 3 |
| `src/webhook/server.ts` | #2-#6 | 3 |
| `src/trading-loop.ts` | #18, #19, #8, #5 | 4 |
| `src/llm/prompts.ts` | #16, #19, #2, #4, #5, #6 | 2→4 |

---

## Batch 1: New Standalone Modules (parallel)

### Task 1: Pair Diversity Module — #19 part 1

**Files:**
- Create: `src/market/pair-diversity.ts`
- Create: `tests/market/pair-diversity.test.ts`

**Step 1: Write failing tests**

Create `tests/market/pair-diversity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildDiversityContext } from '../../src/market/pair-diversity.js';

describe('buildDiversityContext', () => {
  it('returns empty string when no history', () => {
    const result = buildDiversityContext([], ['BTCUSDT', 'ETHUSDT']);
    expect(result).toBe('');
  });

  it('shows cycles since last trade per pair', () => {
    const history = [
      { pair: 'BTCUSDT', cycle: 10 },
      { pair: 'BTCUSDT', cycle: 8 },
      { pair: 'ETHUSDT', cycle: 5 },
    ];
    const result = buildDiversityContext(history, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 12);
    expect(result).toContain('BTCUSDT: 2 cycles ago');
    expect(result).toContain('ETHUSDT: 7 cycles ago');
    expect(result).toContain('SOLUSDT: never traded');
  });

  it('adds concentration warning when >50% on one pair', () => {
    const history = [
      { pair: 'ADAUSDT', cycle: 10 },
      { pair: 'ADAUSDT', cycle: 9 },
      { pair: 'ADAUSDT', cycle: 8 },
      { pair: 'BTCUSDT', cycle: 7 },
    ];
    const result = buildDiversityContext(history, ['BTCUSDT', 'ADAUSDT'], 12);
    expect(result).toContain('WARNING');
    expect(result).toContain('ADAUSDT');
    expect(result).toContain('75%');
  });

  it('no warning when evenly distributed', () => {
    const history = [
      { pair: 'BTCUSDT', cycle: 10 },
      { pair: 'ETHUSDT', cycle: 9 },
      { pair: 'SOLUSDT', cycle: 8 },
    ];
    const result = buildDiversityContext(history, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 12);
    expect(result).not.toContain('WARNING');
  });
});
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/market/pair-diversity.test.ts`

**Step 3: Implement**

Create `src/market/pair-diversity.ts`:

```typescript
export interface PairDecisionEntry {
  pair: string;
  cycle: number;
}

export function buildDiversityContext(
  history: PairDecisionEntry[],
  allPairs: string[],
  currentCycle?: number,
): string {
  if (history.length === 0) return '';

  const cycle = currentCycle ?? Math.max(...history.map(h => h.cycle));
  const lines: string[] = ['### PAIR SELECTION HISTORY'];

  // Last trade cycle per pair
  const lastCycle = new Map<string, number>();
  for (const h of history) {
    const prev = lastCycle.get(h.pair);
    if (!prev || h.cycle > prev) lastCycle.set(h.pair, h.cycle);
  }

  for (const pair of allPairs) {
    const last = lastCycle.get(pair);
    if (last != null) {
      lines.push(`${pair}: ${cycle - last} cycles ago`);
    } else {
      lines.push(`${pair}: never traded`);
    }
  }

  // Concentration warning
  const counts = new Map<string, number>();
  for (const h of history) counts.set(h.pair, (counts.get(h.pair) ?? 0) + 1);
  const total = history.length;
  for (const [pair, count] of counts) {
    const pct = Math.round((count / total) * 100);
    if (pct > 50) {
      lines.push(`⚠ WARNING: ${pair} is ${pct}% of recent trades. Consider other pairs.`);
    }
  }

  return lines.join('\n');
}
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/market/pair-diversity.test.ts`

**Step 5: Commit**

```bash
git add src/market/pair-diversity.ts tests/market/pair-diversity.test.ts
git commit -m "feat(diversity): pair selection history + concentration warning

Part of #19"
```

---

### Task 2: SL/TP Styles Module — #8 part 1

**Files:**
- Create: `src/market/sl-tp-styles.ts`
- Create: `tests/market/sl-tp-styles.test.ts`

**Step 1: Write failing tests**

Create `tests/market/sl-tp-styles.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeSlTpPrices } from '../../src/market/sl-tp-styles.js';
import type { Indicators } from '../../src/indicators/technical.js';

const baseInd: Indicators = {
  rsi: 55, ema20: 100, ema50: 98, atr: 2, trend: 'bullish',
  macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2,
  bollingerUpper: 105, bollingerMiddle: 100, bollingerLower: 95,
  bollingerBandwidth: 10, bollingerPercentB: 0.5,
  volumeRatio: 1.2, vwap: 100, adx: 30,
};

describe('computeSlTpPrices', () => {
  it('fixed style uses raw percentages', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'fixed',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG', indicators: baseInd,
    });
    expect(result.slPrice).toBeCloseTo(97, 1);
    expect(result.tpPrice).toBeCloseTo(106, 1);
  });

  it('atr style uses ATR multiplier for SL', () => {
    const result = computeSlTpPrices({
      slStyle: 'atr', tpStyle: 'fixed',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG', indicators: { ...baseInd, atr: 3 },
    });
    // ATR SL = fillPrice - 1.5 * ATR = 100 - 4.5 = 95.5
    expect(result.slPrice).toBeCloseTo(95.5, 1);
    expect(result.tpPrice).toBeCloseTo(106, 1);
  });

  it('range style uses Bollinger bands', () => {
    const result = computeSlTpPrices({
      slStyle: 'range', tpStyle: 'range',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG',
      indicators: { ...baseInd, bollingerLower: 96, bollingerUpper: 104 },
    });
    expect(result.slPrice).toBeCloseTo(96, 0); // Bollinger lower
    expect(result.tpPrice).toBeCloseTo(104, 0); // Bollinger upper
  });

  it('trailing style tightens SL (80% of fixed)', () => {
    const result = computeSlTpPrices({
      slStyle: 'trailing', tpStyle: 'trailing',
      slPct: 5, tpPct: 10,
      fillPrice: 100, side: 'LONG', indicators: baseInd,
    });
    // Trailing SL: 80% of fixed = 4% → 96
    expect(result.slPrice).toBeCloseTo(96, 0);
    // Trailing TP: 120% of fixed = 12% → 112
    expect(result.tpPrice).toBeCloseTo(112, 0);
  });

  it('momentum TP uses 2x ATR', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'momentum',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'LONG', indicators: { ...baseInd, atr: 4 },
    });
    // Momentum TP = fillPrice + 2 * ATR = 108
    expect(result.tpPrice).toBeCloseTo(108, 0);
  });

  it('SHORT side inverts SL/TP direction', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'fixed',
      slPct: 3, tpPct: 6,
      fillPrice: 100, side: 'SHORT', indicators: baseInd,
    });
    expect(result.slPrice).toBeCloseTo(103, 1); // SL above
    expect(result.tpPrice).toBeCloseTo(94, 1);  // TP below
  });

  it('dca TP uses 50% of fixed (conservative exit)', () => {
    const result = computeSlTpPrices({
      slStyle: 'fixed', tpStyle: 'dca',
      slPct: 5, tpPct: 10,
      fillPrice: 100, side: 'LONG', indicators: baseInd,
    });
    // DCA TP: 50% of fixed = 5% → 105
    expect(result.tpPrice).toBeCloseTo(105, 0);
  });
});
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/market/sl-tp-styles.test.ts`

**Step 3: Implement**

Create `src/market/sl-tp-styles.ts`:

```typescript
import type { Indicators } from '../indicators/technical.js';
import type { FilterProfile } from './filter-profiles.js';

export interface SlTpInput {
  slStyle: FilterProfile['slStyle'];
  tpStyle: FilterProfile['tpStyle'];
  slPct: number;   // LLM-decided SL %
  tpPct: number;   // LLM-decided TP %
  fillPrice: number;
  side: 'LONG' | 'SHORT';
  indicators: Indicators;
}

export interface SlTpPrices {
  slPrice: number;
  tpPrice: number;
}

export function computeSlTpPrices(input: SlTpInput): SlTpPrices {
  const { slStyle, tpStyle, slPct, tpPct, fillPrice, side, indicators } = input;
  const dir = side === 'LONG' ? 1 : -1;

  // SL computation
  let slOffset: number;
  switch (slStyle) {
    case 'atr':
      slOffset = 1.5 * indicators.atr;
      break;
    case 'range':
      slOffset = dir === 1
        ? fillPrice - indicators.bollingerLower
        : indicators.bollingerUpper - fillPrice;
      break;
    case 'trailing':
      slOffset = fillPrice * (slPct * 0.8) / 100; // tighter: 80% of fixed
      break;
    case 'fixed':
    default:
      slOffset = fillPrice * slPct / 100;
      break;
  }

  // TP computation
  let tpOffset: number;
  switch (tpStyle) {
    case 'momentum':
      tpOffset = 2 * indicators.atr;
      break;
    case 'range':
      tpOffset = dir === 1
        ? indicators.bollingerUpper - fillPrice
        : fillPrice - indicators.bollingerLower;
      break;
    case 'trailing':
      tpOffset = fillPrice * (tpPct * 1.2) / 100; // wider: 120% of fixed
      break;
    case 'dca':
      tpOffset = fillPrice * (tpPct * 0.5) / 100; // conservative: 50%
      break;
    case 'fixed':
    default:
      tpOffset = fillPrice * tpPct / 100;
      break;
  }

  return {
    slPrice: fillPrice - dir * slOffset,
    tpPrice: fillPrice + dir * tpOffset,
  };
}
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/market/sl-tp-styles.test.ts`

**Step 5: Commit**

```bash
git add src/market/sl-tp-styles.ts tests/market/sl-tp-styles.test.ts
git commit -m "feat(sl-tp): regime-aware SL/TP style computation

Supports: fixed, atr, range, trailing, momentum, dca styles.

Part of #8"
```

---

## Batch 2: Intelligence Reform (parallel — different files)

### Task 3: Swarm Reform — #16

**Files:**
- Modify: `src/llm/swarm-agent.ts:192-198`
- Modify: `src/llm/prompts.ts:604-670` (expert prompts)
- Modify: `tests/llm/swarm-agent.test.ts`

**Summary of changes:**

1. **Reduce default personas from 5 to 3**: Keep `risk_manager`, `market_structure`, `devils_advocate`. Remove `bull_thesis` and `bear_thesis` (their work is absorbed by `market_structure` which now covers directional analysis).

2. **Skip critique for unanimous HOLD**: If ALL experts say HOLD, skip Stage 2 critique and go straight to judge. Saves 3 LLM calls.

3. **Add actionability score to judge**: Judge prompt now asks for `actionability: 0-100` per decision. Remove "lean HOLD in uncertain conditions" bias from judge prompt.

4. **Keep Grok narrative_expert**: Still optional 4th persona when `grokLlm` provided.

**Step 1: Write failing tests**

Update `tests/llm/swarm-agent.test.ts` — change first test to expect 7 calls (3 experts + 3 critiques + 1 judge):

```typescript
  it('runs 3 experts + 3 critiques + 1 judge = 7 LLM calls (no Grok, no revise)', async () => {
    let callCount = 0;
    const mockRawCall = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        const personas = ['risk_manager', 'market_structure', 'devils_advocate'];
        return Promise.resolve(makeStructuredResponse(personas[callCount - 1], 'HOLD', 60));
      }
      return Promise.resolve(consensusResponse);
    });
    const mockLlm = { call: mockRawCall, lastNextCheckMinutes: undefined } as any;

    const swarm = new SwarmAgent(mockLlm);
    const result = await swarm.getConsensus(makeMinimalPromptData());

    // 3 experts + 3 critiques + 1 judge = 7 (but skip critique if all HOLD)
    // All HOLD → skip critique → 3 experts + 1 judge = 4
    expect(mockRawCall).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(1);
  });
```

Add test for skip-critique-on-unanimous-HOLD:

```typescript
  it('skips critique when all experts vote HOLD', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makeStructuredResponse('test', 'HOLD', 50));
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const swarm = new SwarmAgent(mockLlm);
    await swarm.getConsensus(makeMinimalPromptData());

    // 3 experts + 0 critiques + 1 judge = 4
    expect(mockLlm.call).toHaveBeenCalledTimes(4);
  });

  it('runs critique when experts disagree', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(makeStructuredResponse('rm', 'HOLD', 50));
        if (callCount === 2) return Promise.resolve(makeStructuredResponse('ms', 'LONG', 70));
        if (callCount === 3) return Promise.resolve(makeStructuredResponse('da', 'HOLD', 40));
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const swarm = new SwarmAgent(mockLlm);
    await swarm.getConsensus(makeMinimalPromptData());

    // 3 experts + 3 critiques + 1 judge = 7
    expect(mockLlm.call).toHaveBeenCalledTimes(7);
  });
```

**Step 2: Implement**

In `src/llm/swarm-agent.ts`, line 192-198, change persona list:

```typescript
    const personas: SwarmPersona[] = [
      'risk_manager',
      'market_structure',
      'devils_advocate',
    ];
```

After Stage 1 results loop, before Stage 2, add HOLD-skip logic:

```typescript
    // Skip critique if all experts agree on HOLD
    const validOutputs = expertOutputs.filter(Boolean);
    const allHold = validOutputs.length > 0 && validOutputs.every(eo => eo!.position === 'HOLD');

    // Stage 2: Critique (skip if unanimous HOLD)
    if (!allHold && validOutputs.length >= 2) {
      // ... existing critique logic ...
    }
```

In `buildJudgePrompt()` (prompts.ts), remove any "lean HOLD" language. Add to output format:

```typescript
    "actionability": <0-100, how strongly this recommends action vs inaction>
```

**Step 3: Update existing tests**

Update all tests that assert call counts:
- Test with Grok: 3 Codex + 1 Grok + N critiques + 1 judge
- High-stakes revise: 3 + 3 critiques + 3 revises + 1 = 10

**Step 4: Verify**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Then: `npx vitest run`

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): reduce to 3 personas, skip critique on unanimous HOLD

- Personas: risk_manager, market_structure, devils_advocate
- Skip Stage 2 when all experts vote HOLD (saves 3 LLM calls)
- Judge actionability scoring replaces HOLD bias

Closes #16"
```

---

### Task 4: FlashCrash 2-of-3 Confirmation — #18

**Files:**
- Modify: `src/news/flash-crash.ts`
- Modify: `src/binance/market-data.ts` (add getRecentCandles)
- Modify: `tests/news/flash-crash.test.ts`
- Create: `tests/binance/flash-crash-confirm.test.ts`

**Step 1: Add getRecentCandles to MarketDataFetcher**

In `src/binance/market-data.ts`, add after `getQuickSnapshot()`:

```typescript
  async getRecentCandles(pair: string, interval: string = '1m', limit: number = 5): Promise<CandleData[]> {
    const raw = await this.client.getKlines({ symbol: pair, interval, limit });
    return this.parseCandles(raw);
  }
```

**Step 2: Rewrite FlashCrashScanner with 2-of-3 confirmation**

```typescript
import type { SourceHealthMonitor } from './source-health.js';

export interface FlashCrashResult {
  verdict: 'PANIC' | 'UNCONFIRMED' | 'IGNORE';
  grokSays: 'PANIC' | 'IGNORE';
  priceDropPct?: number;
  volumeSpike?: number;
  reason: string;
}

export class FlashCrashScanner {
    private lastPanicAt = 0;
    private cooldownMs = 15 * 60_000; // 15 min

    constructor(
      private grokClient: any,
      private sourceHealth?: SourceHealthMonitor,
    ) { }

    async scan(
      marketData?: { getRecentCandles: (pair: string, interval?: string, limit?: number) => Promise<any[]> },
      pairs?: string[],
    ): Promise<FlashCrashResult> {
        if (!this.grokClient) return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: 'no grok client' };

        // Cooldown check
        if (Date.now() - this.lastPanicAt < this.cooldownMs) {
          return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: 'cooldown active' };
        }

        const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".`;

        let grokSays: 'PANIC' | 'IGNORE' = 'IGNORE';
        try {
            const raw = await this.grokClient.call(sys, 'Scan crypto X now.', 'grok-4-1-fast-non-reasoning');
            this.sourceHealth?.recordSuccess('grok-flash-crash');
            grokSays = raw.trim().toUpperCase().includes('PANIC') ? 'PANIC' : 'IGNORE';
        } catch (e: any) {
            const msg = e?.message ?? 'unknown';
            console.warn(`[FlashCrash] Grok scan failed: ${msg}`);
            this.sourceHealth?.recordFailure('grok-flash-crash', msg);
            return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: `grok error: ${msg}` };
        }

        if (grokSays === 'IGNORE') {
          return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: 'grok says IGNORE' };
        }

        // Grok says PANIC — confirm with price data
        if (!marketData || !pairs?.length) {
          // No market data to confirm — trust Grok but mark unconfirmed
          return { verdict: 'UNCONFIRMED', grokSays: 'PANIC', reason: 'no market data for confirmation' };
        }

        let signals = 0; // Need 2 of 3: grok(1) + priceDropb(2) + volumeSpike(3)
        signals++; // Grok PANIC = 1 signal

        let maxDrop = 0;
        let maxVolSpike = 0;
        try {
          const btcPair = pairs.find(p => p.includes('BTC')) || pairs[0];
          const candles = await marketData.getRecentCandles(btcPair, '1m', 5);
          if (candles.length >= 2) {
            const firstClose = parseFloat(candles[0].close);
            const lastClose = parseFloat(candles[candles.length - 1].close);
            maxDrop = ((lastClose - firstClose) / firstClose) * 100;

            const avgVol = candles.slice(0, -1).reduce((s, c) => s + parseFloat(c.volume), 0) / Math.max(candles.length - 1, 1);
            const lastVol = parseFloat(candles[candles.length - 1].volume);
            maxVolSpike = avgVol > 0 ? lastVol / avgVol : 0;
          }
        } catch { /* market data optional */ }

        if (maxDrop < -3) signals++; // >3% drop in 5 minutes
        if (maxVolSpike > 3) signals++; // >3x volume spike

        if (signals >= 2) {
          this.lastPanicAt = Date.now();
          return {
            verdict: 'PANIC',
            grokSays: 'PANIC',
            priceDropPct: maxDrop,
            volumeSpike: maxVolSpike,
            reason: `Confirmed: Grok PANIC + ${maxDrop < -3 ? 'price drop' : 'volume spike'}`,
          };
        }

        return {
          verdict: 'UNCONFIRMED',
          grokSays: 'PANIC',
          priceDropPct: maxDrop,
          volumeSpike: maxVolSpike,
          reason: `Grok PANIC but price ${maxDrop.toFixed(1)}%, vol ${maxVolSpike.toFixed(1)}x — insufficient confirmation`,
        };
    }
}
```

**Step 3: Update tests**

Replace `tests/news/flash-crash.test.ts` with comprehensive tests covering:
- IGNORE when no client
- IGNORE when Grok says IGNORE
- UNCONFIRMED when Grok PANIC but no market data
- PANIC when Grok PANIC + price drop >3%
- PANIC when Grok PANIC + volume >3x
- UNCONFIRMED when Grok PANIC but price/vol normal
- Cooldown: IGNORE if within 15m of last PANIC
- sourceHealth tracking (keep existing tests)

**Step 4: Update trading-loop.ts FlashCrash call site**

Find the flash crash scanner call (search for `flashCrashScanner`). Currently:
```typescript
const flashResult = await this.deps.flashCrashScanner.scan();
if (flashResult === 'PANIC') { ... }
```

Change to:
```typescript
const flashResult = await this.deps.flashCrashScanner.scan(
  this.deps.marketData as any,
  this.deps.pairs,
);
if (flashResult.verdict === 'PANIC') { ... }
if (flashResult.verdict === 'UNCONFIRMED') {
  console.warn(`[FlashCrash] UNCONFIRMED: ${flashResult.reason}`);
}
```

**Step 5: Verify and commit**

```bash
npx vitest run
git add src/news/flash-crash.ts src/binance/market-data.ts src/trading-loop.ts tests/news/flash-crash.test.ts
git commit -m "feat(flash-crash): 2-of-3 confirmation (grok + price + volume)

- Grok PANIC alone is UNCONFIRMED
- Confirmed only with price >3% drop OR volume >3x
- 15-min cooldown after confirmed PANIC
- getRecentCandles() added to MarketDataFetcher

Closes #18"
```

---

## Batch 3: Dashboard Data + Endpoint (#2-#6)

### Task 5: Extend PortfolioState + MarketDataFetcher

**Files:**
- Modify: `src/risk/manager.ts` (PortfolioState + Position interfaces)
- Modify: `src/binance/market-data.ts` (getPortfolioState + new methods)
- Modify: `tests/binance/market-data.test.ts`

**Changes to PortfolioState** in `src/risk/manager.ts`:

```typescript
export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  unrealizedPnlPct: number;
  heldHours: number;
  marginUsd?: number;         // NEW #4
  unrealizedPnlUsd?: number;  // NEW #4
}

export interface PortfolioState {
  balanceUsd: number;
  availableUsd: number;
  positions: Position[];
  sessionPnl: number;
  drawdownPct: number;
  marginBalanceUsd?: number;       // NEW #2
  totalUnrealizedPnlUsd?: number;  // NEW #2
  bnbBalance?: number;             // NEW #3
  totalAccountValueUsd?: number;   // NEW #6
}
```

**Changes to getPortfolioState()** in `src/binance/market-data.ts`:

```typescript
  async getPortfolioState(): Promise<PortfolioState> {
    const [balances, positions, accountInfo] = await Promise.all([
      this.client.getBalance(),
      this.client.getPositions(),
      this.client.getAccountInformation().catch(() => null),
    ]);

    const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
    const bnbBalance = balances.find((b: any) => b.asset === 'BNB');
    const balanceUsd = usdtBalance ? parseFloat(usdtBalance.balance || usdtBalance.walletBalance || '0') : 0;
    const availableUsd = usdtBalance ? parseFloat(usdtBalance.availableBalance || '0') : 0;
    const bnbBalanceVal = bnbBalance ? parseFloat(bnbBalance.balance || bnbBalance.walletBalance || '0') : 0;

    // Margin balance + unrealized from account info
    const marginBalanceUsd = accountInfo ? parseFloat(accountInfo.totalMarginBalance || '0') : undefined;
    const totalUnrealizedPnlUsd = accountInfo ? parseFloat(accountInfo.totalUnrealizedProfit || '0') : undefined;

    const openPositions: Position[] = positions
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => {
        const notional = Math.abs(parseFloat(p.notional));
        const leverage = parseInt(p.leverage, 10);
        const margin = notional / leverage;
        const unrealizedProfit = parseFloat(p.unRealizedProfit || p.unrealizedProfit || '0');
        const unrealizedPnlPct = margin > 0 ? (unrealizedProfit / margin) * 100 : 0;
        const updateTime = parseInt(p.updateTime || '0', 10);
        const heldHours = updateTime > 0 ? (Date.now() - updateTime) / 3_600_000 : 0;

        return {
          pair: p.symbol,
          sizeUsd: notional,
          leverage,
          side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
          entryPrice: parseFloat(p.entryPrice || '0'),
          unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
          heldHours: parseFloat(heldHours.toFixed(1)),
          marginUsd: parseFloat(margin.toFixed(2)),
          unrealizedPnlUsd: parseFloat(unrealizedProfit.toFixed(2)),
        };
      });

    // Total account value: sum all non-zero balances (USDT + BNB converted)
    let totalAccountValueUsd = balanceUsd;
    for (const b of balances) {
      if (b.asset === 'USDT' || parseFloat(b.balance || b.walletBalance || '0') === 0) continue;
      try {
        const ticker = await this.client.getMarkPrice({ symbol: `${b.asset}USDT` });
        totalAccountValueUsd += parseFloat(b.balance || b.walletBalance || '0') * parseFloat(ticker.markPrice);
      } catch { /* skip non-USDT assets without price */ }
    }

    return {
      balanceUsd,
      availableUsd,
      positions: openPositions,
      sessionPnl: 0,
      drawdownPct: 0,
      marginBalanceUsd,
      totalUnrealizedPnlUsd,
      bnbBalance: bnbBalanceVal,
      totalAccountValueUsd: parseFloat(totalAccountValueUsd.toFixed(2)),
    };
  }
```

**Add getTodayRealizedPnl()** (#5):

```typescript
  async getTodayRealizedPnl(): Promise<number> {
    try {
      const now = new Date();
      const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const income = await this.client.getIncome({
        incomeType: 'REALIZED_PNL',
        startTime: todayUtc.getTime(),
        limit: 1000,
      });
      return (income as any[]).reduce((sum, i) => sum + parseFloat(i.income || '0'), 0);
    } catch {
      return 0;
    }
  }
```

**Step: Verify and commit**

```bash
npx vitest run
git add src/risk/manager.ts src/binance/market-data.ts tests/binance/market-data.test.ts
git commit -m "feat(dashboard): extend PortfolioState with margin, BNB, total value, per-position PnL

- marginBalanceUsd + totalUnrealizedPnlUsd from getAccountInformation()
- bnbBalance from getBalance()
- totalAccountValueUsd sums all assets converted to USD
- Per-position marginUsd + unrealizedPnlUsd
- getTodayRealizedPnl() from getIncome()

Closes #2, Closes #3, Closes #4, part of #5, Closes #6"
```

---

### Task 6: Webhook /api/status Endpoint

**Files:**
- Modify: `src/webhook/server.ts`
- Modify: `src/index.ts` (pass marketData to server)
- Create: `tests/webhook/status.test.ts`

**Step 1: Update createWebhookServer signature**

```typescript
export function createWebhookServer(
  signalBuffer: SignalBuffer,
  logger: Logger,
  secret?: string,
  marketData?: import('../binance/market-data.js').MarketDataFetcher,
): express.Express {
```

**Step 2: Add /api/status endpoint**

After the `/health` endpoint:

```typescript
  if (marketData) {
    app.get('/api/status', async (_req, res) => {
      try {
        const [portfolio, todayPnl] = await Promise.all([
          marketData.getPortfolioState(),
          marketData.getTodayRealizedPnl(),
        ]);
        res.json({
          balance: {
            usdt: portfolio.balanceUsd,
            available: portfolio.availableUsd,
            margin: portfolio.marginBalanceUsd,
            bnb: portfolio.bnbBalance,
            totalAccountValue: portfolio.totalAccountValueUsd,
            totalUnrealizedPnl: portfolio.totalUnrealizedPnlUsd,
            todayRealizedPnl: todayPnl,
          },
          positions: portfolio.positions.map(p => ({
            pair: p.pair,
            side: p.side,
            sizeUsd: p.sizeUsd,
            leverage: p.leverage,
            entryPrice: p.entryPrice,
            marginUsd: p.marginUsd,
            unrealizedPnlUsd: p.unrealizedPnlUsd,
            unrealizedPnlPct: p.unrealizedPnlPct,
            heldHours: p.heldHours,
          })),
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }
```

**Step 3: Wire in index.ts**

Find `createWebhookServer(signalBuffer, logger, config.webhook.secret)` and add `marketData`:

```typescript
  const app = createWebhookServer(signalBuffer, logger, config.webhook.secret, marketData);
```

**Step 4: Verify and commit**

```bash
npx vitest run
git add src/webhook/server.ts src/index.ts tests/webhook/status.test.ts
git commit -m "feat(dashboard): /api/status endpoint with full account data

- Balance: USDT, margin, BNB, total account value, unrealized, today realized
- Positions: per-position margin, PnL USD/%, entry, held hours

Closes #5, completes #2 #3 #4 #6"
```

---

## Batch 4: Integration Wiring

### Task 7: Wire pair-diversity + SL/TP + prompts

**Files:**
- Modify: `src/trading-loop.ts` (3 changes: diversity tracking, SL/TP, todayPnl)
- Modify: `src/llm/prompts.ts` (diversity context, portfolio details)

**Changes to trading-loop.ts:**

1. **Pair diversity tracking** — Add class field `private pairDecisionHistory: PairDecisionEntry[] = []`. After each LONG/SHORT decision executes, push `{ pair, cycle: this.cycleCount }`. Pass to `buildDiversityContext()` and add to `promptData`.

2. **SL/TP style override** — Before `orders.execute()` for LONG/SHORT, compute style-adjusted SL/TP:

```typescript
// After leverage multiplier, before execute
const pairInd = indicators.get(decision.pair);
const pairProfile = pairRegimes.get(decision.pair)?.profile;
if (pairInd && pairProfile) {
  const { computeSlTpPrices } = await import('./market/sl-tp-styles.js');
  const adjusted = computeSlTpPrices({
    slStyle: pairProfile.slStyle,
    tpStyle: pairProfile.tpStyle,
    slPct: decision.stop_loss_pct,
    tpPct: decision.take_profit_pct,
    fillPrice: parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '0'),
    side: decision.action as 'LONG' | 'SHORT',
    indicators: pairInd,
  });
  // Override LLM's raw percentages with style-adjusted values
  decision.stop_loss_pct = Math.abs((adjusted.slPrice - parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '0')) / parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '1') * 100);
  decision.take_profit_pct = Math.abs((adjusted.tpPrice - parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '0')) / parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '1') * 100);
}
```

3. **Today's realized PnL** — Fetch once per cycle, add to promptData:

```typescript
let todayRealizedPnl = 0;
try {
  todayRealizedPnl = await this.deps.marketData.getTodayRealizedPnl();
} catch { /* optional */ }
```

**Changes to prompts.ts:**

1. Add `pairDiversityContext?: string` and `todayRealizedPnl?: number` to `EnrichedPromptData`
2. In `buildEnrichedPrompt()`, add diversity section:
```typescript
  if (data.pairDiversityContext) {
    parts.push(data.pairDiversityContext);
  }
```
3. In portfolio section, show margin + unrealized per position and today's realized PnL

**Commit:**

```bash
git add src/trading-loop.ts src/llm/prompts.ts
git commit -m "feat(loop): wire pair diversity, SL/TP styles, today realized PnL

- Pair decision history tracked and injected into prompt
- SL/TP percentages adjusted by regime FilterProfile style
- Today's realized PnL fetched and shown in prompt

Closes #8, Closes #19"
```

---

## Verification

```bash
# Full test suite
npx vitest run

# Build check
npm run build

# Deploy
npm run deploy

# Check logs
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'pm2 logs indic-bot --lines 30'

# Test dashboard
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'curl -s localhost:3000/api/status | python3 -m json.tool'
```

## Summary

| Task | Issues | Files | Parallel? |
|------|--------|-------|-----------|
| T1 | #19 part | pair-diversity.ts (new) | ✅ with T2 |
| T2 | #8 part | sl-tp-styles.ts (new) | ✅ with T1 |
| T3 | #16 | swarm-agent.ts, prompts.ts | ✅ with T4 |
| T4 | #18 | flash-crash.ts, market-data.ts | ✅ with T3 |
| T5 | #2-#6 data | manager.ts, market-data.ts | sequential after T4 |
| T6 | #2-#6 endpoint | server.ts, index.ts | after T5 |
| T7 | #8,#19 wire | trading-loop.ts, prompts.ts | after T3,T5 |
