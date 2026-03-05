# Shark Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace single-strategy "cold analyst" bot with 5-regime adaptive trading system that uses regime-specific entry filters, LLM override, decision journal, and trade stories.

**Architecture:** Rule-based regime classifier detects market state from 4h indicators (ADX, EMA, ATR, volume, F&G). Each regime loads a filter profile with adapted RSI/volume/confluence thresholds. LLM receives regime context in prompt and can override classification. Every decision is logged with full context; every closed trade gets a "story" for LLM continuity.

**Tech Stack:** TypeScript ESM, Vitest, existing `Indicators` interface extended with ADX

---

### Task 1: Add ADX to Indicators

ADX (Average Directional Index) is required by the regime classifier but not yet computed.

**Files:**
- Modify: `src/indicators/technical.ts`
- Modify: `tests/indicators/technical.test.ts` (create if not exists)

**Step 1: Write the failing test**

```typescript
// tests/indicators/technical.test.ts
import { describe, it, expect } from 'vitest';
import { computeADX, computeIndicators } from '../../src/indicators/technical.js';

describe('computeADX', () => {
  it('returns 50 (neutral) when not enough data', () => {
    expect(computeADX([1, 2], [0, 1], [1.5, 2.5])).toBe(0);
  });

  it('returns high ADX (>25) for trending data', () => {
    // Monotonically rising prices = strong trend
    const n = 30;
    const highs = Array.from({ length: n }, (_, i) => 100 + i * 2);
    const lows = Array.from({ length: n }, (_, i) => 99 + i * 2);
    const closes = Array.from({ length: n }, (_, i) => 99.5 + i * 2);
    const adx = computeADX(highs, lows, closes);
    expect(adx).toBeGreaterThan(25);
  });

  it('returns low ADX (<25) for ranging data', () => {
    // Oscillating prices = no trend
    const n = 30;
    const highs = Array.from({ length: n }, (_, i) => 101 + Math.sin(i) * 2);
    const lows = Array.from({ length: n }, (_, i) => 99 + Math.sin(i) * 2);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 2);
    const adx = computeADX(highs, lows, closes);
    expect(adx).toBeLessThan(25);
  });
});

describe('computeIndicators includes adx', () => {
  it('returns adx field', () => {
    const n = 30;
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    const highs = closes.map(c => c + 1);
    const lows = closes.map(c => c - 1);
    const volumes = Array.from({ length: n }, () => 1000);
    const ind = computeIndicators(closes, highs, lows, volumes);
    expect(ind).toHaveProperty('adx');
    expect(typeof ind.adx).toBe('number');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indicators/technical.test.ts`
Expected: FAIL — `computeADX` not exported

**Step 3: Write minimal implementation**

Add to `src/indicators/technical.ts`:

```typescript
export function computeADX(
  highs: number[], lows: number[], closes: number[], period = 14,
): number {
  if (highs.length < period + 1) return 0;

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trs: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  // Wilder's smoothing
  const smooth = (arr: number[], p: number): number[] => {
    const result: number[] = [arr.slice(0, p).reduce((s, v) => s + v, 0)];
    for (let i = p; i < arr.length; i++) {
      result.push(result[result.length - 1] - result[result.length - 1] / p + arr[i]);
    }
    return result;
  };

  const smoothTR = smooth(trs, period);
  const smoothPlusDM = smooth(plusDMs, period);
  const smoothMinusDM = smooth(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) { dxValues.push(0); continue; }
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  if (dxValues.length < period) return dxValues[dxValues.length - 1] ?? 0;
  // ADX = smoothed DX
  let adx = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }
  return adx;
}
```

Update `Indicators` interface — add `adx: number;` field (rename existing `atr` stays).
Wait — there's already an `atr` field. We need `adx` as a NEW field:

```typescript
export interface Indicators {
  rsi: number;
  ema20: number;
  ema50: number;
  atr: number;
  adx: number;  // NEW
  trend: 'bullish' | 'bearish' | 'neutral';
  // ... rest unchanged
}
```

Update `computeIndicators()` to compute and include `adx`:
```typescript
const adx = computeADX(highs, lows, closes);
// ... in return:
return { rsi, ema20, ema50, atr, adx, trend, ... };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indicators/technical.test.ts`
Expected: PASS

**Step 5: Run all tests to check nothing broke**

Run: `npx vitest run`
Expected: All PASS (some tests may need `adx` added to mock Indicators objects)

**Step 6: Fix any broken tests**

If tests that mock `Indicators` fail, add `adx: 0` (or appropriate value) to those mocks.

**Step 7: Commit**

```bash
git add src/indicators/technical.ts tests/indicators/
git commit -m "feat: add ADX (Average Directional Index) to indicators"
```

---

### Task 2: Create Market Regime Classifier

**Files:**
- Create: `src/market/regime-classifier.ts`
- Create: `tests/market/regime-classifier.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/market/regime-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyRegime, MarketRegime } from '../../src/market/regime-classifier.js';
import type { Indicators } from '../../src/indicators/technical.js';

function makeIndicators(overrides: Partial<Indicators>): Indicators {
  return {
    rsi: 50, ema20: 100, ema50: 100, atr: 1, adx: 15,
    trend: 'neutral', macd: 0, macdSignal: 0, macdHistogram: 0,
    bollingerUpper: 102, bollingerMiddle: 100, bollingerLower: 98,
    bollingerBandwidth: 4, bollingerPercentB: 50,
    volumeRatio: 1, vwap: 100,
    ...overrides,
  };
}

describe('classifyRegime', () => {
  it('detects bull_trend: EMA20 > EMA50 + ADX > 25 + price > VWAP', () => {
    const ind = makeIndicators({
      ema20: 105, ema50: 100, adx: 30, trend: 'bullish', vwap: 103,
    });
    const result = classifyRegime(ind, 104, { value: 50 });
    expect(result.regime).toBe(MarketRegime.BullTrend);
    expect(result.confidence).toBeGreaterThan(60);
  });

  it('detects bear_trend: EMA20 < EMA50 + ADX > 25 + price < VWAP', () => {
    const ind = makeIndicators({
      ema20: 95, ema50: 100, adx: 30, trend: 'bearish', vwap: 98,
    });
    const result = classifyRegime(ind, 96, { value: 50 });
    expect(result.regime).toBe(MarketRegime.BearTrend);
  });

  it('detects range: ADX < 20 + BB bandwidth < 4%', () => {
    const ind = makeIndicators({
      adx: 15, bollingerBandwidth: 3, trend: 'neutral',
    });
    const result = classifyRegime(ind, 100, { value: 50 });
    expect(result.regime).toBe(MarketRegime.Range);
  });

  it('detects breakout: volume > 1.5x + ATR spike + price outside BB', () => {
    const ind = makeIndicators({
      volumeRatio: 2.0, atr: 3, bollingerPercentB: 105,
      bollingerUpper: 102, bollingerLower: 98,
    });
    // Need atrAvg context — pass previous ATR for spike detection
    const result = classifyRegime(ind, 103, { value: 50 }, { prevAtr: 1.5 });
    expect(result.regime).toBe(MarketRegime.Breakout);
  });

  it('detects capitulation: F&G < 15', () => {
    const ind = makeIndicators({ volumeRatio: 1.0 });
    const result = classifyRegime(ind, 100, { value: 10 });
    expect(result.regime).toBe(MarketRegime.Capitulation);
  });

  it('capitulation overrides other regimes (highest priority)', () => {
    const ind = makeIndicators({
      ema20: 105, ema50: 100, adx: 30, trend: 'bullish', vwap: 103,
    });
    const result = classifyRegime(ind, 104, { value: 8 });
    expect(result.regime).toBe(MarketRegime.Capitulation);
  });

  it('returns factors explaining classification', () => {
    const ind = makeIndicators({
      ema20: 105, ema50: 100, adx: 30, trend: 'bullish', vwap: 103,
    });
    const result = classifyRegime(ind, 104, { value: 50 });
    expect(result.factors.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/regime-classifier.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/market/regime-classifier.ts
import type { Indicators } from '../indicators/technical.js';

export enum MarketRegime {
  BullTrend = 'bull_trend',
  BearTrend = 'bear_trend',
  Range = 'range',
  Breakout = 'breakout',
  Capitulation = 'capitulation',
}

export interface RegimeResult {
  regime: MarketRegime;
  confidence: number;  // 0-100
  factors: string[];
}

export interface RegimeContext {
  prevAtr?: number;  // previous cycle ATR for spike detection
}

export function classifyRegime(
  indicators: Indicators,
  currentPrice: number,
  fearGreed: { value: number },
  ctx?: RegimeContext,
): RegimeResult {
  const factors: string[] = [];

  // Priority 1: Capitulation
  if (fearGreed.value < 15) {
    factors.push(`F&G=${fearGreed.value} (extreme fear)`);
    return { regime: MarketRegime.Capitulation, confidence: 85, factors };
  }
  if (indicators.volumeRatio > 3) {
    factors.push(`Volume ${indicators.volumeRatio.toFixed(1)}x (>3x panic)`);
    return { regime: MarketRegime.Capitulation, confidence: 75, factors };
  }

  // Priority 2: Breakout
  const atrSpike = ctx?.prevAtr ? indicators.atr / ctx.prevAtr > 1.5 : false;
  const outsideBB = indicators.bollingerPercentB > 100 || indicators.bollingerPercentB < 0;
  if (indicators.volumeRatio > 1.5 && (atrSpike || outsideBB)) {
    factors.push(`Volume ${indicators.volumeRatio.toFixed(1)}x (>1.5x)`);
    if (atrSpike) factors.push(`ATR spike ${(indicators.atr / (ctx?.prevAtr ?? 1)).toFixed(1)}x`);
    if (outsideBB) factors.push(`Price outside BB (%B=${indicators.bollingerPercentB.toFixed(0)})`);
    const conf = 60 + (indicators.volumeRatio > 2 ? 15 : 0) + (atrSpike && outsideBB ? 10 : 0);
    return { regime: MarketRegime.Breakout, confidence: Math.min(conf, 95), factors };
  }

  // Priority 3: Trend (bull or bear)
  if (indicators.adx > 25) {
    if (indicators.ema20 > indicators.ema50 && currentPrice > indicators.vwap) {
      factors.push(`ADX=${indicators.adx.toFixed(0)} (trending)`);
      factors.push('EMA20 > EMA50');
      factors.push('Price > VWAP');
      const conf = 60 + Math.min((indicators.adx - 25) * 2, 30);
      return { regime: MarketRegime.BullTrend, confidence: Math.min(conf, 95), factors };
    }
    if (indicators.ema20 < indicators.ema50 && currentPrice < indicators.vwap) {
      factors.push(`ADX=${indicators.adx.toFixed(0)} (trending)`);
      factors.push('EMA20 < EMA50');
      factors.push('Price < VWAP');
      const conf = 60 + Math.min((indicators.adx - 25) * 2, 30);
      return { regime: MarketRegime.BearTrend, confidence: Math.min(conf, 95), factors };
    }
  }

  // Priority 4: Range
  if (indicators.adx < 20 && indicators.bollingerBandwidth < 4) {
    factors.push(`ADX=${indicators.adx.toFixed(0)} (<20, no trend)`);
    factors.push(`BB width=${indicators.bollingerBandwidth.toFixed(1)}% (<4%)`);
    const conf = 60 + (20 - indicators.adx) * 2;
    return { regime: MarketRegime.Range, confidence: Math.min(conf, 90), factors };
  }

  // Default: check weaker signals
  if (indicators.trend === 'bullish') {
    factors.push('Weak bull (EMA alignment but ADX < 25)');
    return { regime: MarketRegime.BullTrend, confidence: 45, factors };
  }
  if (indicators.trend === 'bearish') {
    factors.push('Weak bear (EMA alignment but ADX < 25)');
    return { regime: MarketRegime.BearTrend, confidence: 45, factors };
  }

  factors.push('No clear regime detected');
  return { regime: MarketRegime.Range, confidence: 30, factors };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/market/regime-classifier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/market/regime-classifier.ts tests/market/regime-classifier.test.ts
git commit -m "feat: add market regime classifier (5 regimes)"
```

---

### Task 3: Create Filter Profiles

**Files:**
- Create: `src/market/filter-profiles.ts`
- Create: `tests/market/filter-profiles.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/market/filter-profiles.test.ts
import { describe, it, expect } from 'vitest';
import { getFilterProfile, MarketRegime } from '../../src/market/filter-profiles.js';

describe('getFilterProfile', () => {
  it('returns bull_trend profile with wider RSI range', () => {
    const profile = getFilterProfile(MarketRegime.BullTrend);
    expect(profile.rsiRange).toEqual([45, 80]);
    expect(profile.volumeMin).toBe(0.6);
    expect(profile.confluenceMin).toBe(2);
  });

  it('returns bear_trend profile', () => {
    const profile = getFilterProfile(MarketRegime.BearTrend);
    expect(profile.rsiRange).toEqual([20, 55]);
    expect(profile.minConfidence).toBe(55);
  });

  it('returns range profile with halved leverage', () => {
    const profile = getFilterProfile(MarketRegime.Range);
    expect(profile.leverageMultiplier).toBe(0.5);
  });

  it('returns breakout profile with high volume requirement', () => {
    const profile = getFilterProfile(MarketRegime.Breakout);
    expect(profile.volumeMin).toBe(1.2);
    expect(profile.confluenceMin).toBe(3);
  });

  it('returns capitulation profile with minimal filters', () => {
    const profile = getFilterProfile(MarketRegime.Capitulation);
    expect(profile.confluenceMin).toBe(1);
    expect(profile.leverageMultiplier).toBe(0.25);
    expect(profile.minConfidence).toBe(45);
  });

  it('all profiles have required fields', () => {
    for (const regime of Object.values(MarketRegime)) {
      const p = getFilterProfile(regime as MarketRegime);
      expect(p).toHaveProperty('rsiRange');
      expect(p).toHaveProperty('volumeMin');
      expect(p).toHaveProperty('confluenceMin');
      expect(p).toHaveProperty('leverageMultiplier');
      expect(p).toHaveProperty('minConfidence');
      expect(p).toHaveProperty('slStyle');
      expect(p).toHaveProperty('tpStyle');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/filter-profiles.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/market/filter-profiles.ts
export { MarketRegime } from './regime-classifier.js';
import { MarketRegime } from './regime-classifier.js';

export interface FilterProfile {
  rsiRange: [number, number];     // [min, max] for entry
  volumeMin: number;              // minimum volume ratio
  confluenceMin: number;          // minimum confluence factors (out of 5)
  leverageMultiplier: number;     // multiply config.maxLeverage by this
  minConfidence: number;          // minimum LLM confidence
  slStyle: 'trailing' | 'fixed' | 'atr' | 'range';
  tpStyle: 'trailing' | 'fixed' | 'momentum' | 'range' | 'dca';
}

const PROFILES: Record<MarketRegime, FilterProfile> = {
  [MarketRegime.BullTrend]: {
    rsiRange: [45, 80],
    volumeMin: 0.6,
    confluenceMin: 2,
    leverageMultiplier: 1,
    minConfidence: 50,
    slStyle: 'trailing',
    tpStyle: 'trailing',
  },
  [MarketRegime.BearTrend]: {
    rsiRange: [20, 55],
    volumeMin: 0.6,
    confluenceMin: 2,
    leverageMultiplier: 1,
    minConfidence: 55,
    slStyle: 'fixed',
    tpStyle: 'fixed',
  },
  [MarketRegime.Range]: {
    rsiRange: [30, 70],
    volumeMin: 0.5,
    confluenceMin: 2,
    leverageMultiplier: 0.5,
    minConfidence: 50,
    slStyle: 'range',
    tpStyle: 'range',
  },
  [MarketRegime.Breakout]: {
    rsiRange: [0, 100],  // any RSI
    volumeMin: 1.2,
    confluenceMin: 3,
    leverageMultiplier: 1,
    minConfidence: 60,
    slStyle: 'atr',
    tpStyle: 'momentum',
  },
  [MarketRegime.Capitulation]: {
    rsiRange: [0, 100],  // any RSI
    volumeMin: 0.8,
    confluenceMin: 1,
    leverageMultiplier: 0.25,
    minConfidence: 45,
    slStyle: 'fixed',
    tpStyle: 'dca',
  },
};

export function getFilterProfile(regime: MarketRegime): FilterProfile {
  return PROFILES[regime];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/market/filter-profiles.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/market/filter-profiles.ts tests/market/filter-profiles.test.ts
git commit -m "feat: add regime-adaptive filter profiles"
```

---

### Task 4: Create Decision Journal Logger

**Files:**
- Create: `src/logging/decision-journal.ts`
- Create: `tests/logging/decision-journal.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/logging/decision-journal.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DecisionJournal, type JournalEntry } from '../../src/logging/decision-journal.js';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { MarketRegime } from '../../src/market/regime-classifier.js';

const TEST_FILE = '/tmp/test-decision-journal.jsonl';

describe('DecisionJournal', () => {
  let journal: DecisionJournal;

  beforeEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    journal = new DecisionJournal(TEST_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  it('logs a decision entry as JSONL', () => {
    const entry: JournalEntry = {
      pair: 'BTCUSDT',
      regime: MarketRegime.BullTrend,
      regimeConfidence: 80,
      regimeOverride: null,
      filtersApplied: {
        rsi: { value: 55, range: [45, 80], passed: true },
        volume: { value: 0.7, min: 0.6, passed: true },
        confluence: { score: 3, min: 2, passed: true },
      },
      action: 'LONG',
      reasoning: 'Strong trend with pullback',
      confidence: 72,
      riskValidation: 'PASSED',
      indicatorsSnapshot: { rsi_1h: 55, rsi_4h: 60, volume_ratio: 0.7 },
    };

    journal.log(entry);

    const content = readFileSync(TEST_FILE, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.pair).toBe('BTCUSDT');
    expect(parsed.regime).toBe('bull_trend');
    expect(parsed.ts).toBeDefined();
    expect(parsed.filters_applied.rsi.passed).toBe(true);
  });

  it('appends multiple entries', () => {
    journal.log({ pair: 'BTCUSDT', regime: MarketRegime.Range, regimeConfidence: 60, regimeOverride: null, filtersApplied: {}, action: 'HOLD', reasoning: 'test', confidence: 50, riskValidation: 'N/A', indicatorsSnapshot: {} });
    journal.log({ pair: 'ETHUSDT', regime: MarketRegime.Range, regimeConfidence: 60, regimeOverride: null, filtersApplied: {}, action: 'HOLD', reasoning: 'test', confidence: 50, riskValidation: 'N/A', indicatorsSnapshot: {} });

    const lines = readFileSync(TEST_FILE, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('does not throw on write errors', () => {
    const bad = new DecisionJournal('/nonexistent/path/journal.jsonl');
    expect(() => bad.log({ pair: 'X', regime: MarketRegime.Range, regimeConfidence: 0, regimeOverride: null, filtersApplied: {}, action: 'HOLD', reasoning: '', confidence: 0, riskValidation: 'N/A', indicatorsSnapshot: {} })).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/logging/decision-journal.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/logging/decision-journal.ts
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MarketRegime } from '../market/regime-classifier.js';

export interface FilterCheck {
  value: number;
  range?: [number, number];
  min?: number;
  score?: number;
  passed: boolean;
}

export interface JournalEntry {
  pair: string;
  regime: MarketRegime;
  regimeConfidence: number;
  regimeOverride: string | null;
  filtersApplied: Record<string, FilterCheck | { score: number; min: number; passed: boolean }>;
  action: string;
  reasoning: string;
  confidence: number;
  riskValidation: string;
  indicatorsSnapshot: Record<string, number | string>;
}

export class DecisionJournal {
  constructor(private logFile: string) {}

  log(entry: JournalEntry): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        pair: entry.pair,
        regime: entry.regime,
        regime_confidence: entry.regimeConfidence,
        regime_override: entry.regimeOverride,
        filters_applied: entry.filtersApplied,
        action: entry.action,
        reasoning: entry.reasoning,
        confidence: entry.confidence,
        risk_validation: entry.riskValidation,
        indicators_snapshot: entry.indicatorsSnapshot,
      }) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');
    } catch {
      // Non-critical — never crash the bot over logging
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/logging/decision-journal.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/logging/decision-journal.ts tests/logging/decision-journal.test.ts
git commit -m "feat: add decision journal logger"
```

---

### Task 5: Create Trade Story Logger

**Files:**
- Create: `src/logging/trade-story.ts`
- Create: `tests/logging/trade-story.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/logging/trade-story.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeStoryLogger, type TradeStory } from '../../src/logging/trade-story.js';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';

const TEST_FILE = '/tmp/test-trade-stories.jsonl';

describe('TradeStoryLogger', () => {
  let logger: TradeStoryLogger;

  beforeEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    logger = new TradeStoryLogger(TEST_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  it('logs a trade story as JSONL', () => {
    const story: TradeStory = {
      pair: 'BTCUSDT',
      direction: 'LONG',
      entryTime: '2026-03-05T10:00:00Z',
      exitTime: '2026-03-05T14:00:00Z',
      entryPrice: 72000,
      exitPrice: 73500,
      pnlPct: 2.1,
      regimeAtEntry: 'bull_trend',
      regimeAtExit: 'range',
      story: 'Entered on pullback, held through regime change.',
      lesson: 'Patience paid off.',
    };

    logger.log(story);

    const content = readFileSync(TEST_FILE, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.pair).toBe('BTCUSDT');
    expect(parsed.pnl_pct).toBe(2.1);
    expect(parsed.story).toContain('pullback');
  });

  it('getRecent returns last N stories', () => {
    for (let i = 0; i < 10; i++) {
      logger.log({
        pair: 'BTCUSDT', direction: 'LONG',
        entryTime: `2026-03-05T${i}:00:00Z`, exitTime: `2026-03-05T${i + 1}:00:00Z`,
        entryPrice: 70000 + i * 100, exitPrice: 70100 + i * 100,
        pnlPct: 1, regimeAtEntry: 'bull_trend', regimeAtExit: 'bull_trend',
        story: `Trade ${i}`, lesson: `Lesson ${i}`,
      });
    }

    const recent = logger.getRecent(5);
    expect(recent.length).toBe(5);
    expect(recent[0].story).toBe('Trade 5');
    expect(recent[4].story).toBe('Trade 9');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/logging/trade-story.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/logging/trade-story.ts
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TradeStory {
  pair: string;
  direction: 'LONG' | 'SHORT';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  regimeAtEntry: string;
  regimeAtExit: string;
  story: string;
  lesson: string;
}

export class TradeStoryLogger {
  constructor(private logFile: string) {}

  log(story: TradeStory): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        pair: story.pair,
        direction: story.direction,
        entry_time: story.entryTime,
        exit_time: story.exitTime,
        entry_price: story.entryPrice,
        exit_price: story.exitPrice,
        pnl_pct: story.pnlPct,
        regime_at_entry: story.regimeAtEntry,
        regime_at_exit: story.regimeAtExit,
        story: story.story,
        lesson: story.lesson,
      }) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');
    } catch {
      // Non-critical
    }
  }

  getRecent(count: number): TradeStory[] {
    try {
      if (!existsSync(this.logFile)) return [];
      const lines = readFileSync(this.logFile, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-count).map(line => {
        const p = JSON.parse(line);
        return {
          pair: p.pair,
          direction: p.direction,
          entryTime: p.entry_time,
          exitTime: p.exit_time,
          entryPrice: p.entry_price,
          exitPrice: p.exit_price,
          pnlPct: p.pnl_pct,
          regimeAtEntry: p.regime_at_entry,
          regimeAtExit: p.regime_at_exit,
          story: p.story,
          lesson: p.lesson,
        };
      });
    } catch {
      return [];
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/logging/trade-story.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/logging/trade-story.ts tests/logging/trade-story.test.ts
git commit -m "feat: add trade story logger with getRecent()"
```

---

### Task 6: Update System Prompt for Regime-Adaptive Strategy

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `tests/llm/client.test.ts` (if prompt-dependent tests exist)

**Step 1: Read current prompt code**

Read `src/llm/prompts.ts` lines 17-113 to identify exact text to replace.

**Step 2: Update `buildSystemPrompt()`**

Replace hardcoded RSI/volume/confluence rules with regime-adaptive instructions:

- **Remove** lines containing:
  - `RSI 40-65 for LONG, 35-60 for SHORT. Avoid entries with RSI > 70 or RSI < 30.`
  - `Only enter if volume ratio > 1.0x`
  - `Volume < 0.8x = avoid`
  - The 5-item confluence checklist (lines 46-52)
  - `This is LIVE money. Be selective.`

- **Add** in their place:
```
## REGIME-ADAPTIVE STRATEGY
You will receive CURRENT REGIME and ACTIVE FILTERS in the data. Adapt your strategy to the regime:
- Bull Trend: Follow the trend. Enter on pullbacks to VWAP/EMA. Use trailing SL/TP.
- Bear Trend: Short-bias. Enter on rallies to resistance. Tight fixed SL/TP.
- Range: Buy support, sell resistance. Use range bounds for SL/TP.
- Breakout: Enter on confirmed breakout with high volume. Wide ATR-based SL.
- Capitulation: Minimal position sizes. Only highest-conviction entries. Tight SL.

Your ACTIVE FILTERS tell you the allowed RSI range, volume minimum, and confluence requirement for THIS regime.
Do not apply the old fixed RSI 40-65 rule — use the regime's filter profile.

You MAY override the detected regime if you see clear evidence it's wrong.
If you override, include "regime_override" and "override_reason" in your response.

Be decisive — you are a shark, not a goldfish. Enter when your regime's filters pass.
```

**Step 3: Update `EnrichedPromptData` interface**

Add fields:
```typescript
regime?: string;           // current detected regime
regimeConfidence?: number;
regimeFactors?: string[];
filterProfile?: {
  rsiRange: [number, number];
  volumeMin: number;
  confluenceMin: number;
  leverageMultiplier: number;
  minConfidence: number;
  slStyle: string;
  tpStyle: string;
};
tradeStories?: Array<{ pair: string; direction: string; pnlPct: number; story: string; lesson: string }>;
```

**Step 4: Update `buildEnrichedPrompt()` / `buildUserPrompt()`**

Add two new sections to the assembled prompt:

```typescript
// After indicators section, before news:
if (data.regime) {
  parts.push(`\n## CURRENT REGIME: ${data.regime.toUpperCase()} (confidence: ${data.regimeConfidence}%)`);
  parts.push(`Factors: ${data.regimeFactors?.join(', ')}`);
  if (data.filterProfile) {
    const fp = data.filterProfile;
    parts.push(`\n## ACTIVE FILTERS (for ${data.regime})`);
    parts.push(`RSI entry range: ${fp.rsiRange[0]}-${fp.rsiRange[1]}`);
    parts.push(`Volume minimum: ${fp.volumeMin}x`);
    parts.push(`Confluence minimum: ${fp.confluenceMin}/5`);
    parts.push(`Leverage multiplier: ${fp.leverageMultiplier}x of max`);
    parts.push(`Min confidence: ${fp.minConfidence}`);
    parts.push(`SL style: ${fp.slStyle} | TP style: ${fp.tpStyle}`);
  }
}

// After trade performance section:
if (data.tradeStories?.length) {
  parts.push('\n## RECENT TRADE STORIES');
  parts.push('Learn from these — do not repeat mistakes, do not exit good trades early:');
  for (const s of data.tradeStories) {
    parts.push(`- ${s.pair} ${s.direction} (${s.pnlPct > 0 ? '+' : ''}${s.pnlPct.toFixed(1)}%): ${s.story} Lesson: ${s.lesson}`);
  }
}
```

**Step 5: Update `parseResponse()` in `src/llm/client.ts`**

Extract `regime_override` and `override_reason` from LLM response:

In `parseResponse()`, after parsing `decisions` and `next_check_minutes`:
```typescript
const regimeOverride = parsed.regime_override ?? null;
const overrideReason = parsed.override_reason ?? null;
return { decisions: parsed.decisions, nextCheckMinutes, regimeOverride, overrideReason };
```

Update return type to include these optional fields.

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: PASS (fix any mock issues in prompt-dependent tests)

**Step 7: Commit**

```bash
git add src/llm/prompts.ts src/llm/client.ts
git commit -m "feat: update prompts for regime-adaptive strategy"
```

---

### Task 7: Integrate Regime Classifier + Journal into Trading Loop

This is the integration task — wire everything together in `src/trading-loop.ts`.

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/index.ts` (create and pass new deps)
- Modify: `tests/trading-loop.test.ts`

**Step 1: Update `TradingLoopDeps` interface**

Add to `TradingLoopDeps`:
```typescript
decisionJournal?: DecisionJournal;
tradeStoryLogger?: TradeStoryLogger;
```

**Step 2: Add regime classification in `runOnce()`**

After computing 4h indicators (around line 187), add:

```typescript
// Classify regime per pair using 4h indicators
const regimes = new Map<string, RegimeResult>();
for (const [pair, ind4h] of indicators4h) {
  const snap = snapshots.find(s => s.pair === pair);
  const price = snap ? parseFloat(snap.markPrice) : ind4h.vwap;
  regimes.set(pair, classifyRegime(ind4h, price, fearGreed, { prevAtr: this.prevAtr.get(pair) }));
  this.prevAtr.set(pair, ind4h.atr);
}
```

Add `private prevAtr = new Map<string, number>();` to class fields.

**Step 3: Pass regime + filter profile to prompt data**

When building `promptData` for LLM (around line 225):

```typescript
// Use first pair's regime as overall (or most common)
const firstRegime = regimes.values().next().value;
const filterProfile = firstRegime ? getFilterProfile(firstRegime.regime) : undefined;

const promptData: EnrichedPromptData = {
  // ... existing fields ...
  regime: firstRegime?.regime,
  regimeConfidence: firstRegime?.confidence,
  regimeFactors: firstRegime?.factors,
  filterProfile: filterProfile ? {
    rsiRange: filterProfile.rsiRange,
    volumeMin: filterProfile.volumeMin,
    confluenceMin: filterProfile.confluenceMin,
    leverageMultiplier: filterProfile.leverageMultiplier,
    minConfidence: filterProfile.minConfidence,
    slStyle: filterProfile.slStyle,
    tpStyle: filterProfile.tpStyle,
  } : undefined,
  tradeStories: this.deps.tradeStoryLogger?.getRecent(5)?.map(s => ({
    pair: s.pair, direction: s.direction, pnlPct: s.pnlPct, story: s.story, lesson: s.lesson,
  })),
};
```

**Step 4: Log decisions to journal**

After each decision is processed (around line 380), log to journal:

```typescript
if (this.deps.decisionJournal) {
  const pairRegime = regimes.get(decision.pair);
  const pairInd1h = indicators.get(decision.pair);
  const pairInd4h = indicators4h.get(decision.pair);
  this.deps.decisionJournal.log({
    pair: decision.pair,
    regime: pairRegime?.regime ?? MarketRegime.Range,
    regimeConfidence: pairRegime?.confidence ?? 0,
    regimeOverride: regimeOverride,  // from LLM response
    filtersApplied: {
      rsi: { value: pairInd1h?.rsi ?? 0, range: filterProfile?.rsiRange ?? [0, 100], passed: true },
      volume: { value: pairInd1h?.volumeRatio ?? 0, min: filterProfile?.volumeMin ?? 0, passed: true },
      confluence: { score: 0, min: filterProfile?.confluenceMin ?? 0, passed: true },
    },
    action: decision.action,
    reasoning: decision.reasoning,
    confidence: decision.confidence ?? 0,
    riskValidation: validationResult?.approved ? 'PASSED' : validationResult?.reason ?? 'N/A',
    indicatorsSnapshot: {
      rsi_1h: pairInd1h?.rsi ?? 0,
      rsi_4h: pairInd4h?.rsi ?? 0,
      volume_ratio: pairInd1h?.volumeRatio ?? 0,
      adx_4h: pairInd4h?.adx ?? 0,
      atr_4h: pairInd4h?.atr ?? 0,
      vwap: pairInd1h?.vwap ?? 0,
    },
  });
}
```

**Step 5: Log trade stories on CLOSE**

After executing a CLOSE (around line 410), log trade story:

```typescript
if (decision.action === 'CLOSE' && this.deps.tradeStoryLogger) {
  const pos = portfolio.positions.find(p => p.pair === decision.pair);
  if (pos) {
    const pairRegime = regimes.get(decision.pair);
    this.deps.tradeStoryLogger.log({
      pair: decision.pair,
      direction: pos.side,
      entryTime: '', // not available currently — leave empty
      exitTime: new Date().toISOString(),
      entryPrice: pos.entryPrice,
      exitPrice: parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '0'),
      pnlPct: pos.unrealizedPnlPct,
      regimeAtEntry: 'unknown', // not tracked yet — could store in memory
      regimeAtExit: pairRegime?.regime ?? 'unknown',
      story: decision.reasoning,
      lesson: pos.unrealizedPnlPct > 0 ? 'Profitable exit.' : 'Loss cut — review entry conditions.',
    });
  }
}
```

**Step 6: Update `src/index.ts` to create and inject new deps**

```typescript
import { DecisionJournal } from './logging/decision-journal.js';
import { TradeStoryLogger } from './logging/trade-story.js';

// In main():
const decisionJournal = new DecisionJournal('logs/decision-journal.jsonl');
const tradeStoryLogger = new TradeStoryLogger('logs/trade-stories.jsonl');

// Add to TradingLoop deps:
const loop = new TradingLoop({
  // ... existing deps ...
  decisionJournal,
  tradeStoryLogger,
});
```

**Step 7: Update tests**

Add mock `decisionJournal` and `tradeStoryLogger` to `tests/trading-loop.test.ts`:

```typescript
const mockJournal = { log: vi.fn() };
const mockStoryLogger = { log: vi.fn(), getRecent: vi.fn().mockReturnValue([]) };

// In TradingLoop constructor:
decisionJournal: mockJournal,
tradeStoryLogger: mockStoryLogger,
```

**Step 8: Run all tests**

Run: `npx vitest run`
Expected: PASS

**Step 9: Commit**

```bash
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat: integrate regime classifier + decision journal into trading loop"
```

---

### Task 8: End-to-End Test on Demo Server

**Step 1: Run all tests locally**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Deploy to demo server**

```bash
rsync -az --delete --exclude=node_modules --exclude=.git --exclude=.env --exclude=dist --exclude=logs \
  /Users/mykolat/Documents/Projects/00_Amikus/04_Indic/ ubuntu@10.0.54.10:~/indic-bot/
ssh ubuntu@10.0.54.10 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd ~/indic-bot && npm install && pm2 restart indic-bot'
```

**Step 3: Wait for one cycle (10 min) and check logs**

```bash
ssh ubuntu@10.0.54.10 'cat ~/indic-bot/logs/decision-journal.jsonl | tail -5'
```

Verify: journal entries appear with `regime`, `filters_applied`, `indicators_snapshot`.

**Step 4: Check pm2 logs for errors**

```bash
ssh ubuntu@10.0.54.10 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && pm2 logs indic-bot --lines 30 --nostream'
```

Expected: No new errors. Regime classification visible in output.

**Step 5: Run audit on demo**

```bash
ssh ubuntu@10.0.54.10 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd ~/indic-bot && npx tsx scripts/audit.ts'
```

**Step 6: Commit final state if any fixes needed**

```bash
git add -A && git commit -m "fix: post-deployment fixes for shark mode"
```
