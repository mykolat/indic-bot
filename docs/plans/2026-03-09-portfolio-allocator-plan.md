# Portfolio Allocator — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dynamic portfolio rebalancing so the bot can evict weak positions or trim them to make room for better opportunities when margin is exhausted.

**Architecture:** Three new modules: (1) `portfolio-allocator.ts` — scoring + rebalancing decision logic, (2) `opportunity-cache.ts` — deduplicates repeated blocked candidates, (3) structured `MARGIN_SHORTFALL` rejection from RiskManager that triggers allocator in TradingLoop. Allocator uses a unified forward-looking scoring model (re-entry value) for both open positions and new candidates.

**Tech Stack:** TypeScript ESM (`.js` imports), Vitest, Binance `USDMClient` via `binance` npm package.

**Design doc:** `docs/plans/2026-03-08-dynamic-margin-rebalancing.md` (v3)

---

### Task 1: Structured MARGIN_SHORTFALL rejection from RiskManager

**Files:**
- Modify: `src/risk/manager.ts:52-56` (ValidationResult interface)
- Modify: `src/risk/manager.ts:236-241` (margin check)
- Test: `tests/risk/manager.test.ts`

**Step 1: Write the failing test**

Add to `tests/risk/manager.test.ts`:

```typescript
it('returns MARGIN_SHORTFALL with details when margin insufficient', () => {
  const rm = new RiskManager({
    maxLeverage: 10, maxPositionPct: 50, maxExposurePct: 150,
    maxStopLossPct: 5, maxLossUsd: 30, maxLossPct: 0, maxDrawdownPct: 15,
  });
  const decision: TradeDecision = {
    pair: 'LINKUSDT', action: 'SHORT', size_pct: 30,
    leverage: 10, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
    confidence: 75,
  };
  const portfolio: PortfolioState = {
    balanceUsd: 188, availableUsd: 20, positions: [
      { pair: 'ETHUSDT', sizeUsd: 280, leverage: 5, side: 'SHORT', entryPrice: 1941, unrealizedPnlPct: -3.8, heldHours: 6, marginUsd: 56 },
    ],
    sessionPnl: 3, drawdownPct: 0,
  };

  const result = rm.validate(decision, portfolio);
  expect(result.approved).toBe(false);
  expect(result.marginShortfall).toBeDefined();
  expect(result.marginShortfall!.neededMargin).toBeCloseTo(56.4, 0);
  expect(result.marginShortfall!.availableMargin).toBe(20);
  expect(result.marginShortfall!.shortfall).toBeCloseTo(36.4, 0);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/manager.test.ts -t "MARGIN_SHORTFALL"`
Expected: FAIL — `marginShortfall` does not exist on ValidationResult

**Step 3: Implement**

In `src/risk/manager.ts`, update `ValidationResult`:

```typescript
export interface ValidationResult {
  approved: boolean;
  reason?: string;
  shutdown?: boolean;
  marginShortfall?: {
    neededMargin: number;
    availableMargin: number;
    shortfall: number;
  };
}
```

Update the margin check (~line 238-241):

```typescript
if (portfolio.availableUsd > 0 && newMargin > portfolio.availableUsd) {
  return {
    approved: false,
    reason: `margin needed $${newMargin.toFixed(2)} exceeds available $${portfolio.availableUsd.toFixed(2)}`,
    marginShortfall: {
      neededMargin: newMargin,
      availableMargin: portfolio.availableUsd,
      shortfall: newMargin - portfolio.availableUsd,
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts
git commit -m "feat(risk): structured MARGIN_SHORTFALL rejection with shortfall details"
```

---

### Task 2: Portfolio Allocator — scoring functions

**Files:**
- Create: `src/risk/portfolio-allocator.ts`
- Test: `tests/risk/portfolio-allocator.test.ts`

**Step 1: Write the failing tests**

Create `tests/risk/portfolio-allocator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeEntryModel,
  computeRetainScore,
  computeReentryValue,
  computeCandidateValue,
  type ScoringContext,
} from '../../src/risk/portfolio-allocator.js';
import type { Position, TradeDecision } from '../../src/risk/manager.js';

describe('PortfolioAllocator — scoring', () => {
  const baseCtx: ScoringContext = {
    regime: 'BearTrend',
    confluenceFactors: ['trend', 'vwap', 'rsi', 'news'],
    atr: 2.5,
  };

  describe('computeEntryModel', () => {
    it('scores a strong SHORT in BearTrend highly', () => {
      const score = computeEntryModel({
        confidence: 77,
        remainingRR: 2.8,   // tp/sl from current price
        regimeFit: 1.0,     // SHORT in BearTrend
        confluenceNorm: 0.8, // 4/5
        momentumConfirmation: 0.7,
      });
      expect(score).toBeGreaterThan(55);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('scores a weak LONG in BearTrend low', () => {
      const score = computeEntryModel({
        confidence: 58,
        remainingRR: 1.2,
        regimeFit: 0.1,     // LONG in BearTrend
        confluenceNorm: 0.4,
        momentumConfirmation: 0.2,
      });
      expect(score).toBeLessThan(30);
    });

    it('clamps output to 0-100', () => {
      const high = computeEntryModel({
        confidence: 100, remainingRR: 5, regimeFit: 1.0,
        confluenceNorm: 1.0, momentumConfirmation: 1.0,
      });
      expect(high).toBeLessThanOrEqual(100);

      const low = computeEntryModel({
        confidence: 55, remainingRR: 0.3, regimeFit: 0.0,
        confluenceNorm: 0.0, momentumConfirmation: 0.0,
      });
      expect(low).toBeGreaterThanOrEqual(0);
    });
  });

  describe('computeRetainScore', () => {
    it('scores a stagnant losing position low', () => {
      const score = computeRetainScore({
        thesisFit: 0.8,      // regime still valid
        remainingRR: 1.5,    // mark-to-TP / mark-to-SL
        momentum: 0.1,       // barely moving
        tpProgress: 0,       // negative PnL → 0
        heldHours: 6,
        pnlPct: -3.8,
      });
      expect(score).toBeLessThan(40);
    });

    it('scores a position near TP highly', () => {
      const score = computeRetainScore({
        thesisFit: 1.0,
        remainingRR: 0.5,    // close to TP, small remaining R
        momentum: 0.8,
        tpProgress: 0.85,
        heldHours: 2,
        pnlPct: 4.5,
      });
      expect(score).toBeGreaterThan(65);
    });

    it('applies stagnation penalty for dead-money positions', () => {
      const stagnant = computeRetainScore({
        thesisFit: 0.7, remainingRR: 2.0, momentum: 0.1,
        tpProgress: 0.05, heldHours: 4, pnlPct: 0.3,
      });
      const fresh = computeRetainScore({
        thesisFit: 0.7, remainingRR: 2.0, momentum: 0.1,
        tpProgress: 0.05, heldHours: 0.3, pnlPct: 0.3,
      });
      expect(stagnant).toBeLessThan(fresh);
    });
  });

  describe('computeReentryValue', () => {
    it('deducts exit cost and correlation penalty', () => {
      const position: Position = {
        pair: 'ETHUSDT', sizeUsd: 280, leverage: 5, side: 'SHORT',
        entryPrice: 1941, unrealizedPnlPct: -3.8, heldHours: 6, marginUsd: 56,
      };
      const portfolio = [
        { pair: 'SOLUSDT', side: 'SHORT' as const },
        { pair: 'BNBUSDT', side: 'SHORT' as const },
      ];
      const value = computeReentryValue(position, portfolio, {
        confidence: 65,
        remainingRR: 1.8,
        regimeFit: 1.0,
        confluenceNorm: 0.8,
        momentumConfirmation: 0.2,
        exitCost: 5,
        correlationPenalty: 5,
      });
      expect(value).toBeLessThan(
        computeEntryModel({
          confidence: 65, remainingRR: 1.8, regimeFit: 1.0,
          confluenceNorm: 0.8, momentumConfirmation: 0.2,
        })
      );
    });
  });

  describe('computeCandidateValue', () => {
    it('deducts entry cost and correlation penalty', () => {
      const value = computeCandidateValue({
        confidence: 77,
        remainingRR: 2.8,
        regimeFit: 1.0,
        confluenceNorm: 0.8,
        momentumConfirmation: 0.7,
        entryCost: 4,
        correlationPenalty: 5,
      });
      const raw = computeEntryModel({
        confidence: 77, remainingRR: 2.8, regimeFit: 1.0,
        confluenceNorm: 0.8, momentumConfirmation: 0.7,
      });
      expect(value).toBe(raw - 4 - 5);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/portfolio-allocator.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `src/risk/portfolio-allocator.ts`**

```typescript
export interface EntryModelInput {
  confidence: number;        // 55-100
  remainingRR: number;       // tp_distance / sl_distance from current price
  regimeFit: number;         // 0..1
  confluenceNorm: number;    // 0..1
  momentumConfirmation: number; // 0..1
}

export interface RetainScoreInput {
  thesisFit: number;         // 0..1 from invalidator check
  remainingRR: number;       // mark-to-TP / mark-to-SL
  momentum: number;          // 0..1 ATR-normalized
  tpProgress: number;        // 0..1 how far toward TP
  heldHours: number;
  pnlPct: number;            // unrealized PnL %
}

export interface ReentryValueInput extends EntryModelInput {
  exitCost: number;          // 0..20 normalized
  correlationPenalty: number; // 0..20
}

export interface CandidateValueInput extends EntryModelInput {
  entryCost: number;         // 0..20 normalized
  correlationPenalty: number; // 0..20
}

export interface ScoringContext {
  regime: string;
  confluenceFactors: string[];
  atr: number;
}

/**
 * Shared scoring model for any trade setup (open or candidate).
 * Returns 0..100.
 */
export function computeEntryModel(input: EntryModelInput): number {
  const confidenceNorm = Math.max(0, Math.min(1, (input.confidence - 55) / 45));
  const rrNorm = Math.max(0, Math.min(1, Math.min(input.remainingRR, 4) / 4));
  const regimeFit = Math.max(0, Math.min(1, input.regimeFit));
  const confluence = Math.max(0, Math.min(1, input.confluenceNorm));
  const momentum = Math.max(0, Math.min(1, input.momentumConfirmation));

  const raw = 100 * (
    confidenceNorm * 0.25
    + rrNorm * 0.25
    + confluence * 0.20
    + regimeFit * 0.20
    + momentum * 0.10
  );

  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/**
 * Diagnostic score for open positions. Forward-looking.
 * Returns 0..100.
 */
export function computeRetainScore(input: RetainScoreInput): number {
  const thesisFit = Math.max(0, Math.min(1, input.thesisFit));
  const rrNorm = Math.max(0, Math.min(1, Math.min(input.remainingRR, 4) / 4));
  const momentum = Math.max(0, Math.min(1, input.momentum));
  const tpProgress = Math.max(0, Math.min(1, input.tpProgress));

  // Stagnation: penalize positions with tiny PnL held for hours
  let stagnationPenalty = 0;
  if (Math.abs(input.pnlPct) < 1 && input.heldHours > 2) {
    stagnationPenalty = Math.min(0.3, (input.heldHours - 2) * 0.05);
  }
  const vitality = Math.max(0, 1 - stagnationPenalty);

  const raw = 100 * (
    thesisFit * 0.30
    + rrNorm * 0.25
    + momentum * 0.20
    + tpProgress * 0.15
    + vitality * 0.10
  );

  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/**
 * Re-entry value for an open position: "would I open this fresh now?"
 * Uses same entry_model but deducts exit cost and correlation penalty.
 */
export function computeReentryValue(
  _position: { pair: string; side: string },
  _portfolio: { pair: string; side: string }[],
  input: ReentryValueInput,
): number {
  const base = computeEntryModel(input);
  return Math.max(0, base - input.exitCost - input.correlationPenalty);
}

/**
 * Candidate value for a new trade idea.
 * Uses same entry_model but deducts entry cost and correlation penalty.
 */
export function computeCandidateValue(input: CandidateValueInput): number {
  const base = computeEntryModel(input);
  return Math.max(0, base - input.entryCost - input.correlationPenalty);
}

// --- Correlation ---

const ASSET_CLUSTERS: Record<string, string> = {
  BTCUSDT: 'btc', ETHUSDT: 'eth',
  SOLUSDT: 'alt-l1', AVAXUSDT: 'alt-l1', SUIUSDT: 'alt-l1', NEARUSDT: 'alt-l1', APTUSDT: 'alt-l1',
  LINKUSDT: 'alt-mid', ADAUSDT: 'alt-mid', LTCUSDT: 'alt-mid',
  DOGEUSDT: 'meme', PEPEUSDT: 'meme',
  BNBUSDT: 'exchange', XRPUSDT: 'alt-mid',
};

const ADJACENT_CLUSTERS: Record<string, string[]> = {
  'btc': ['eth'],
  'eth': ['btc', 'alt-l1'],
  'alt-l1': ['eth', 'alt-mid'],
  'alt-mid': ['alt-l1'],
  'meme': ['alt-l1'],
  'exchange': [],
};

export function computeCorrelationPenalty(
  pair: string,
  side: string,
  portfolio: { pair: string; side: string }[],
): number {
  const cluster = ASSET_CLUSTERS[pair] ?? 'unknown';
  let penalty = 0;

  for (const pos of portfolio) {
    if (pos.pair === pair) continue;
    const posCluster = ASSET_CLUSTERS[pos.pair] ?? 'unknown';
    if (pos.side === side) {
      if (posCluster === cluster) {
        penalty += 15;
      } else if (ADJACENT_CLUSTERS[cluster]?.includes(posCluster)) {
        penalty += 5;
      }
    }
  }

  return Math.min(penalty, 30); // cap
}

// --- Regime fit ---

export function computeRegimeFit(action: 'LONG' | 'SHORT', regime: string): number {
  const fits: Record<string, Record<string, number>> = {
    BearTrend:    { SHORT: 1.0, LONG: 0.1 },
    BullTrend:    { SHORT: 0.1, LONG: 1.0 },
    Capitulation: { SHORT: 0.9, LONG: 0.1 },
    Range:        { SHORT: 0.6, LONG: 0.6 },
    Breakout:     { SHORT: 0.5, LONG: 0.7 },
    Scalping:     { SHORT: 0.5, LONG: 0.5 },
  };
  return fits[regime]?.[action] ?? 0.5;
}

// --- Swap cost estimation ---

export function estimateSwapCost(
  closeNotional: number,
  openNotional: number,
): number {
  const takerFeePct = 0.04 / 100;
  const slippagePct = 0.02 / 100;
  const closeFee = closeNotional * takerFeePct;
  const openFee = openNotional * takerFeePct;
  const closeSlippage = closeNotional * slippagePct;
  const openSlippage = openNotional * slippagePct;
  const churnPenalty = 3;
  const uncertaintyBand = 2;
  return closeFee + openFee + closeSlippage + openSlippage + churnPenalty + uncertaintyBand;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/risk/portfolio-allocator.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/risk/portfolio-allocator.ts tests/risk/portfolio-allocator.test.ts
git commit -m "feat(risk): portfolio allocator scoring — entry model, retain score, correlation penalty"
```

---

### Task 3: Rebalancing decision engine

**Files:**
- Modify: `src/risk/portfolio-allocator.ts` (add `evaluateRebalancing`)
- Test: `tests/risk/portfolio-allocator.test.ts` (add rebalancing tests)

**Step 1: Write the failing tests**

Add to `tests/risk/portfolio-allocator.test.ts`:

```typescript
import {
  evaluateRebalancing,
  type RebalanceAction,
  type RebalanceInput,
} from '../../src/risk/portfolio-allocator.js';

describe('evaluateRebalancing', () => {
  const makeInput = (overrides?: Partial<RebalanceInput>): RebalanceInput => ({
    shortfall: {
      neededMargin: 56,
      availableMargin: 20,
      shortfall: 36,
    },
    candidate: {
      pair: 'LINKUSDT', action: 'SHORT' as const, size_pct: 30,
      leverage: 12, stop_loss_pct: 1.8, take_profit_pct: 5.5,
      reasoning: 'test', confidence: 77,
    },
    candidateValue: 60,
    positions: [
      {
        pair: 'ETHUSDT', side: 'SHORT' as const, marginUsd: 56,
        heldHours: 6, tpProgress: 0, reentryValue: 20,
        notional: 280,
      },
      {
        pair: 'BNBUSDT', side: 'SHORT' as const, marginUsd: 55,
        heldHours: 6, tpProgress: 0.16, reentryValue: 48,
        notional: 275,
      },
    ],
    maxRebalancesPerHour: 2,
    rebalanceCountLastHour: 0,
    minHoldMinutes: 30,
    tpProgressLock: 0.8,
    ...overrides,
  });

  it('approves swap when candidate much better than weakest', () => {
    const result = evaluateRebalancing(makeInput());
    expect(result.action).not.toBe('skip');
    expect(result.evictPair).toBe('ETHUSDT');
  });

  it('skips when candidate not significantly better', () => {
    const result = evaluateRebalancing(makeInput({
      candidateValue: 25,  // barely better than ETH's 20
    }));
    expect(result.action).toBe('skip');
  });

  it('skips when rate limited', () => {
    const result = evaluateRebalancing(makeInput({
      rebalanceCountLastHour: 2,
    }));
    expect(result.action).toBe('skip');
    expect(result.reason).toBe('rate_limited');
  });

  it('does not evict positions near TP', () => {
    const result = evaluateRebalancing(makeInput({
      positions: [
        { pair: 'ETHUSDT', side: 'SHORT' as const, marginUsd: 56, heldHours: 6, tpProgress: 0.85, reentryValue: 15, notional: 280 },
        { pair: 'BNBUSDT', side: 'SHORT' as const, marginUsd: 55, heldHours: 6, tpProgress: 0.85, reentryValue: 18, notional: 275 },
      ],
    }));
    expect(result.action).toBe('skip');
  });

  it('does not evict positions held less than min hold', () => {
    const result = evaluateRebalancing(makeInput({
      positions: [
        { pair: 'ETHUSDT', side: 'SHORT' as const, marginUsd: 56, heldHours: 0.3, tpProgress: 0, reentryValue: 10, notional: 280 },
      ],
    }));
    expect(result.action).toBe('skip');
  });

  it('prefers trim when position has enough margin', () => {
    const result = evaluateRebalancing(makeInput({
      shortfall: { neededMargin: 56, availableMargin: 30, shortfall: 26 },
    }));
    // ETH has 56 margin, shortfall is 26 → trim ~46% instead of full swap
    if (result.action !== 'skip') {
      expect(result.action).toBe('trim_and_open');
      expect(result.trimPct).toBeDefined();
      expect(result.trimPct!).toBeLessThan(1);
      expect(result.trimPct!).toBeGreaterThan(0);
    }
  });

  it('does not evict same pair as candidate', () => {
    const result = evaluateRebalancing(makeInput({
      candidate: {
        pair: 'ETHUSDT', action: 'SHORT' as const, size_pct: 30,
        leverage: 12, stop_loss_pct: 2, take_profit_pct: 5,
        reasoning: 'test', confidence: 77,
      },
      positions: [
        { pair: 'ETHUSDT', side: 'SHORT' as const, marginUsd: 56, heldHours: 6, tpProgress: 0, reentryValue: 20, notional: 280 },
      ],
    }));
    expect(result.action).toBe('skip');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/portfolio-allocator.test.ts -t "evaluateRebalancing"`
Expected: FAIL — `evaluateRebalancing` not exported

**Step 3: Implement `evaluateRebalancing`**

Add to `src/risk/portfolio-allocator.ts`:

```typescript
export interface RebalanceInput {
  shortfall: {
    neededMargin: number;
    availableMargin: number;
    shortfall: number;
  };
  candidate: TradeDecision;
  candidateValue: number;
  positions: {
    pair: string;
    side: 'LONG' | 'SHORT';
    marginUsd: number;
    heldHours: number;
    tpProgress: number;
    reentryValue: number;
    notional: number;
  }[];
  maxRebalancesPerHour: number;
  rebalanceCountLastHour: number;
  minHoldMinutes: number;
  tpProgressLock: number;
}

export interface RebalanceAction {
  action: 'swap_full' | 'trim_and_open' | 'skip';
  evictPair?: string;
  trimPct?: number;
  reason?: string;
  delta?: number;
  swapCost?: number;
}

const MIN_DELTA = 5;

export function evaluateRebalancing(input: RebalanceInput): RebalanceAction {
  if (input.rebalanceCountLastHour >= input.maxRebalancesPerHour) {
    return { action: 'skip', reason: 'rate_limited' };
  }

  const eligible = input.positions
    .filter(p => p.pair !== input.candidate.pair)
    .filter(p => p.heldHours >= input.minHoldMinutes / 60)
    .filter(p => p.tpProgress < input.tpProgressLock)
    .sort((a, b) => a.reentryValue - b.reentryValue);

  for (const pos of eligible) {
    const swapCostRaw = estimateSwapCost(pos.notional, input.shortfall.neededMargin * (input.candidate.leverage || 5));
    // Normalize swap cost to score scale (rough: $1 ≈ 1 point at $188 balance)
    const swapCostNorm = Math.min(15, swapCostRaw * 0.5);

    const delta = input.candidateValue - pos.reentryValue - swapCostNorm;

    if (delta < MIN_DELTA) continue;

    // Can we trim instead of full swap?
    const canTrim = pos.marginUsd > input.shortfall.shortfall * 1.4;
    if (canTrim) {
      const trimPct = Math.min(0.8, input.shortfall.shortfall / pos.marginUsd);
      return {
        action: 'trim_and_open',
        evictPair: pos.pair,
        trimPct,
        delta,
        swapCost: swapCostNorm,
      };
    }

    if (pos.marginUsd >= input.shortfall.shortfall) {
      return {
        action: 'swap_full',
        evictPair: pos.pair,
        delta,
        swapCost: swapCostNorm,
      };
    }
  }

  return { action: 'skip', reason: 'no_profitable_swap' };
}
```

Add import at top of file:
```typescript
import type { TradeDecision } from './manager.js';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/risk/portfolio-allocator.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/risk/portfolio-allocator.ts tests/risk/portfolio-allocator.test.ts
git commit -m "feat(risk): rebalancing decision engine with trim/swap/skip logic"
```

---

### Task 4: Opportunity Cache

**Files:**
- Create: `src/risk/opportunity-cache.ts`
- Test: `tests/risk/opportunity-cache.test.ts`

**Step 1: Write the failing tests**

Create `tests/risk/opportunity-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpportunityCache, type CandidateEpisode } from '../../src/risk/opportunity-cache.js';

describe('OpportunityCache', () => {
  let cache: OpportunityCache;

  beforeEach(() => {
    cache = new OpportunityCache();
  });

  it('caches a new candidate episode', () => {
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 65, price: 8.50,
    });
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached).toBeDefined();
    expect(cached!.entryScore).toBe(65);
  });

  it('returns undefined for unknown episode', () => {
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached).toBeUndefined();
  });

  it('updates existing episode on re-add', () => {
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 65, price: 8.50,
    });
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 70, price: 8.45,
    });
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached!.entryScore).toBe(70);
  });

  it('expires episodes after TTL', () => {
    vi.useFakeTimers();
    cache.add({
      pair: 'LINKUSDT', side: 'SHORT', setupType: 'trend_continuation',
      regime: 'BearTrend', entryScore: 65, price: 8.50, ttlMs: 60_000,
    });
    vi.advanceTimersByTime(61_000);
    const cached = cache.get('LINKUSDT', 'SHORT', 'trend_continuation', 'BearTrend');
    expect(cached).toBeUndefined();
    vi.useRealTimers();
  });

  it('returns all active candidates sorted by score', () => {
    cache.add({ pair: 'LINKUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 65, price: 8.50 });
    cache.add({ pair: 'DOGEUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 72, price: 0.15 });
    cache.add({ pair: 'APTUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 55, price: 5.0 });

    const all = cache.getActiveCandidates();
    expect(all).toHaveLength(3);
    expect(all[0].pair).toBe('DOGEUSDT');  // highest score first
    expect(all[2].pair).toBe('APTUSDT');   // lowest score last
  });

  it('invalidates on regime change', () => {
    cache.add({ pair: 'LINKUSDT', side: 'SHORT', setupType: 'tc', regime: 'BearTrend', entryScore: 65, price: 8.50 });
    cache.invalidateByRegime('BullTrend');
    const cached = cache.get('LINKUSDT', 'SHORT', 'tc', 'BearTrend');
    expect(cached).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/opportunity-cache.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `src/risk/opportunity-cache.ts`**

```typescript
export interface CandidateEpisode {
  pair: string;
  side: 'LONG' | 'SHORT';
  setupType: string;
  regime: string;
  entryScore: number;
  price: number;
  firstSeen: number;
  lastUpdated: number;
  ttlMs: number;
}

interface AddInput {
  pair: string;
  side: string;
  setupType: string;
  regime: string;
  entryScore: number;
  price: number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 min

export class OpportunityCache {
  private episodes = new Map<string, CandidateEpisode>();

  private key(pair: string, side: string, setupType: string, regime: string): string {
    return `${pair}:${side}:${setupType}:${regime}`;
  }

  add(input: AddInput): void {
    const k = this.key(input.pair, input.side, input.setupType, input.regime);
    const existing = this.episodes.get(k);
    const now = Date.now();

    this.episodes.set(k, {
      pair: input.pair,
      side: input.side as 'LONG' | 'SHORT',
      setupType: input.setupType,
      regime: input.regime,
      entryScore: input.entryScore,
      price: input.price,
      firstSeen: existing?.firstSeen ?? now,
      lastUpdated: now,
      ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    });
  }

  get(pair: string, side: string, setupType: string, regime: string): CandidateEpisode | undefined {
    const k = this.key(pair, side, setupType, regime);
    const ep = this.episodes.get(k);
    if (!ep) return undefined;
    if (Date.now() - ep.firstSeen > ep.ttlMs) {
      this.episodes.delete(k);
      return undefined;
    }
    return ep;
  }

  getActiveCandidates(): CandidateEpisode[] {
    const now = Date.now();
    const active: CandidateEpisode[] = [];
    for (const [k, ep] of this.episodes) {
      if (now - ep.firstSeen > ep.ttlMs) {
        this.episodes.delete(k);
      } else {
        active.push(ep);
      }
    }
    return active.sort((a, b) => b.entryScore - a.entryScore);
  }

  invalidateByRegime(newRegime: string): void {
    for (const [k, ep] of this.episodes) {
      if (ep.regime !== newRegime) {
        this.episodes.delete(k);
      }
    }
  }

  clear(): void {
    this.episodes.clear();
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/risk/opportunity-cache.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/risk/opportunity-cache.ts tests/risk/opportunity-cache.test.ts
git commit -m "feat(risk): opportunity cache for deduplicating blocked trade episodes"
```

---

### Task 5: Allocator config in config.yaml

**Files:**
- Modify: `src/config.ts` (add allocation section)
- Modify: `config.yaml` on VM (add allocation defaults — disabled)

**Step 1: Write the failing test**

Add to existing config tests or create inline test. Since config is simple, verify by reading.

In `tests/risk/portfolio-allocator.test.ts`, add:

```typescript
import { loadConfig } from '../../src/config.js';

describe('config — allocation section', () => {
  it('loads allocation config with defaults', () => {
    const cfg = loadConfig();
    expect(cfg.allocation).toBeDefined();
    expect(cfg.allocation.enabled).toBe(false);
    expect(cfg.allocation.minFreeMarginPct).toBe(15);
    expect(cfg.allocation.maxRebalancesPerHour).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/portfolio-allocator.test.ts -t "config"`
Expected: FAIL — `cfg.allocation` is undefined

**Step 3: Implement**

In `src/config.ts`, after `positionManagement` section, add:

```typescript
// After line ~136 (positionManagement closing brace)
const alloc = y.allocation ?? {};

// In return object, after positionManagement:
allocation: {
  enabled: alloc.enabled ?? false,
  minFreeMarginPct: alloc.minFreeMarginPct ?? 15,
  maxRebalancesPerHour: alloc.maxRebalancesPerHour ?? 2,
  minHoldBeforeEvictMinutes: alloc.minHoldBeforeEvictMinutes ?? 30,
  tpProgressLockThreshold: alloc.tpProgressLockThreshold ?? 0.8,
  minDelta: alloc.minDelta ?? 5,
  churnPenalty: alloc.churnPenalty ?? 3,
  uncertaintyBand: alloc.uncertaintyBand ?? 2,
},
```

Also add the `allocation` type to the config interface at the top of the file.

**Step 4: Run tests**

Run: `npx vitest run tests/risk/portfolio-allocator.test.ts -t "config"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts tests/risk/portfolio-allocator.test.ts
git commit -m "feat(config): add allocation section with feature flag (disabled by default)"
```

---

### Task 6: Wire allocator into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts:1236-1248` (after `!validation.approved` block)
- Modify: `src/trading-loop.ts:44-110` (TradingLoopDeps — add allocator deps)
- Modify: `src/index.ts` (wire allocator into deps)

**Step 1: No unit test — integration point**

This is wiring code. The correctness comes from Tasks 1-4 tests plus manual verification on testnet.

**Step 2: Implement**

Add to `TradingLoopDeps`:

```typescript
allocator?: {
  enabled: boolean;
  config: import('./config.js').AllocationConfig;
};
opportunityCache?: import('./risk/opportunity-cache.js').OpportunityCache;
```

Add fields to `TradingLoop`:

```typescript
private rebalanceCountLastHour = 0;
private lastRebalanceReset = Date.now();
```

In the `!validation.approved` block (after line 1248, replacing `continue`), add:

```typescript
if (!validation.approved) {
  logger.logDecision({ type: 'RISK_REJECTED', pair: decision.pair, reason: validation.reason });
  this.deps.memoryKeeper?.addRejection({
    pair: decision.pair,
    action: decision.action,
    reason: validation.reason || 'unknown',
    timestamp: new Date().toISOString(),
  });

  if (validation.shutdown) {
    this._shutdown = true;
    logger.logError('SHUTDOWN', 'Max loss reached — stopping bot');
    continue;
  }

  // --- Portfolio Rebalancing ---
  if (
    validation.marginShortfall
    && this.deps.allocator?.enabled
    && (decision.action === 'LONG' || decision.action === 'SHORT')
  ) {
    const allocConfig = this.deps.allocator.config;

    // Reset hourly counter
    if (Date.now() - this.lastRebalanceReset > 3_600_000) {
      this.rebalanceCountLastHour = 0;
      this.lastRebalanceReset = Date.now();
    }

    // Cache the blocked candidate
    this.deps.opportunityCache?.add({
      pair: decision.pair,
      side: decision.action,
      setupType: decision.setup_type ?? 'unknown',
      regime: marketRegime,
      entryScore: 0, // will be computed below
      price: parseFloat(snapshots.find(s => s.pair === decision.pair)?.markPrice ?? '0'),
    });

    // Compute candidate value
    const candCorr = computeCorrelationPenalty(
      decision.pair, decision.action,
      portfolio.positions.map(p => ({ pair: p.pair, side: p.side })),
    );
    const candRegimeFit = computeRegimeFit(decision.action, marketRegime);
    const pairInd = indicators.get(decision.pair);
    const candidateValue = computeCandidateValue({
      confidence: decision.confidence ?? 60,
      remainingRR: decision.take_profit_pct / Math.max(decision.stop_loss_pct, 0.1),
      regimeFit: candRegimeFit,
      confluenceNorm: (pairConfluence.get(decision.pair)?.score ?? 2) / 5,
      momentumConfirmation: pairInd ? Math.min(1, Math.max(0, pairInd.volumeRatio * 0.5)) : 0.5,
      entryCost: 4, // ~$4 in fees normalized
      correlationPenalty: candCorr,
    });

    // Score existing positions
    const positionsScored = portfolio.positions.map(pos => {
      const posInd = indicators.get(pos.pair);
      const posCtx = positionContexts.find(c => c.pair === pos.pair);
      const slPrice = posCtx ? Number(posCtx.sl_price) : 0;
      const tpPrice = posCtx ? Number(posCtx.tp_price) : 0;
      const markPrice = pos.entryPrice * (1 + (pos.side === 'LONG' ? 1 : -1) * pos.unrealizedPnlPct / 100);

      let remainingRR = 1.0;
      if (slPrice > 0 && tpPrice > 0 && markPrice > 0) {
        const distToTp = Math.abs(tpPrice - markPrice);
        const distToSl = Math.abs(markPrice - slPrice);
        remainingRR = distToSl > 0 ? distToTp / distToSl : 0;
      }

      const tpProgress = pos.unrealizedPnlPct > 0 && tpPrice > 0
        ? Math.min(1, pos.unrealizedPnlPct / (Math.abs(tpPrice - pos.entryPrice) / pos.entryPrice * 100))
        : 0;

      const posCorr = computeCorrelationPenalty(
        pos.pair, pos.side,
        portfolio.positions.filter(p => p.pair !== pos.pair).map(p => ({ pair: p.pair, side: p.side })),
      );
      const posRegimeFit = computeRegimeFit(pos.side as 'LONG' | 'SHORT', marketRegime);

      const reentryValue = computeReentryValue(
        { pair: pos.pair, side: pos.side },
        portfolio.positions.filter(p => p.pair !== pos.pair).map(p => ({ pair: p.pair, side: p.side })),
        {
          confidence: 60, // conservative — we don't re-run LLM
          remainingRR,
          regimeFit: posRegimeFit,
          confluenceNorm: (pairConfluence.get(pos.pair)?.score ?? 2) / 5,
          momentumConfirmation: posInd ? Math.min(1, Math.max(0, posInd.volumeRatio * 0.3)) : 0.3,
          exitCost: 4,
          correlationPenalty: posCorr,
        },
      );

      return {
        pair: pos.pair,
        side: pos.side as 'LONG' | 'SHORT',
        marginUsd: pos.marginUsd ?? pos.sizeUsd / pos.leverage,
        heldHours: pos.heldHours,
        tpProgress,
        reentryValue,
        notional: pos.sizeUsd,
      };
    });

    const rebalanceResult = evaluateRebalancing({
      shortfall: validation.marginShortfall,
      candidate: decision,
      candidateValue,
      positions: positionsScored,
      maxRebalancesPerHour: allocConfig.maxRebalancesPerHour,
      rebalanceCountLastHour: this.rebalanceCountLastHour,
      minHoldMinutes: allocConfig.minHoldBeforeEvictMinutes,
      tpProgressLock: allocConfig.tpProgressLockThreshold,
    });

    if (rebalanceResult.action !== 'skip') {
      console.log(`[Allocator] ${rebalanceResult.action}: evict ${rebalanceResult.evictPair} (reentry=${positionsScored.find(p => p.pair === rebalanceResult.evictPair)?.reentryValue?.toFixed(1)}) → open ${decision.pair} (value=${candidateValue.toFixed(1)}) delta=${rebalanceResult.delta?.toFixed(1)}`);

      // Execute eviction
      const evictPos = portfolio.positions.find(p => p.pair === rebalanceResult.evictPair);
      if (evictPos) {
        if (rebalanceResult.action === 'trim_and_open' && rebalanceResult.trimPct) {
          const trimResult = await orders.partialClose(evictPos.pair, evictPos.side, rebalanceResult.trimPct);
          if (!trimResult.success) {
            console.error(`[Allocator] Trim failed: ${trimResult.error}`);
            continue;
          }
          console.log(`[Allocator] Trimmed ${evictPos.pair} by ${(rebalanceResult.trimPct * 100).toFixed(0)}%`);
        } else {
          const closeResult = await orders.close(evictPos.pair, evictPos.side);
          if (!closeResult.success) {
            console.error(`[Allocator] Close failed: ${closeResult.error}`);
            continue;
          }
          this.lastClosedAt.set(evictPos.pair, Date.now());
          console.log(`[Allocator] Closed ${evictPos.pair} to free margin`);

          // Log the eviction close
          const pnlUsd = evictPos.unrealizedPnlPct * (evictPos.marginUsd ?? evictPos.sizeUsd / evictPos.leverage) / 100;
          this.deps.memory.addTrade({
            pair: evictPos.pair,
            action: 'CLOSE',
            pnlUsd: parseFloat(pnlUsd.toFixed(2)),
            pnlPct: evictPos.unrealizedPnlPct,
            closedAt: new Date().toISOString(),
          });
          logger.logTrade({ type: 'REBALANCE_CLOSE', pair: evictPos.pair });
        }

        // Execute new position
        const execResult = await orders.execute(decision, portfolio.balanceUsd);
        if (execResult.success) {
          this.rebalanceCountLastHour++;
          logger.logTrade({
            type: 'REBALANCE_OPEN', pair: decision.pair,
            orderId: execResult.orderId,
            fillPrice: execResult.fillPrice,
          });
          this.deps.memory.setLastOrderResult(
            `${decision.pair} ${decision.action} (rebalanced from ${rebalanceResult.evictPair})`
          );

          // DB logging
          if (cycleId) {
            insertTradeExecution({
              decision_id: decisionId,
              pair: decision.pair,
              side: decision.action === 'LONG' ? 'buy' : 'sell',
              order_type: 'market',
              quantity: execResult.quantity,
              fill_price: execResult.fillPrice,
              order_id: execResult.orderId,
              sl_price: execResult.slPrice,
              tp_price: execResult.tpPrice,
              leverage: decision.leverage,
              commission_usd: execResult.commissionUsd,
              commission_asset: execResult.commissionAsset,
              entry_thesis: decision.reasoning,
            }).catch(e => console.error('[DB] rebalance exec error:', e.message));
          }
        } else {
          console.error(`[Allocator] Open failed after eviction: ${execResult.error}`);
          logger.logError('REBALANCE_OPEN_FAIL', execResult.error || 'unknown');
        }
      }
    } else {
      // Log skip reason for observability
      if (rebalanceResult.reason !== 'rate_limited') {
        console.log(`[Allocator] Skip: ${rebalanceResult.reason} (candidate=${candidateValue.toFixed(1)})`);
      }
    }
  }

  continue;
}
```

Add imports at top of `trading-loop.ts`:

```typescript
import { computeCorrelationPenalty, computeRegimeFit, computeReentryValue, computeCandidateValue, evaluateRebalancing } from './risk/portfolio-allocator.js';
import { insertTradeExecution } from './db/repository.js';
```

**Step 3: Wire in `src/index.ts`**

Add to the TradingLoop constructor deps:

```typescript
import { OpportunityCache } from './risk/opportunity-cache.js';

// In the wiring section:
const opportunityCache = new OpportunityCache();
// In TradingLoop constructor deps:
allocator: {
  enabled: config.allocation.enabled,
  config: config.allocation,
},
opportunityCache,
```

**Step 4: Verify existing tests still pass**

Run: `npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/trading-loop.ts src/index.ts
git commit -m "feat(loop): wire portfolio allocator into trading loop — rebalance on MARGIN_SHORTFALL"
```

---

### Task 7: DB table for rebalancing events

**Files:**
- Create: Supabase migration for `portfolio_rebalancing_events`

**Step 1: Create migration**

```sql
CREATE TABLE IF NOT EXISTS portfolio_rebalancing_events (
  id SERIAL PRIMARY KEY,
  cycle_id INTEGER REFERENCES cycles(id),
  action_type TEXT NOT NULL,           -- swap_full, trim_and_open, skip
  evicted_pair TEXT,
  evicted_reentry_value NUMERIC,
  new_pair TEXT NOT NULL,
  new_candidate_value NUMERIC,
  delta NUMERIC,
  swap_cost NUMERIC,
  trim_pct NUMERIC,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Step 2: Add repository function**

In `src/db/repository.ts`, add:

```typescript
export async function insertRebalancingEvent(e: {
  cycle_id?: number;
  action_type: string;
  evicted_pair?: string;
  evicted_reentry_value?: number;
  new_pair: string;
  new_candidate_value?: number;
  delta?: number;
  swap_cost?: number;
  trim_pct?: number;
  reason?: string;
}): Promise<void> {
  await q().query(
    `INSERT INTO portfolio_rebalancing_events (cycle_id, action_type, evicted_pair, evicted_reentry_value, new_pair, new_candidate_value, delta, swap_cost, trim_pct, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.cycle_id, e.action_type, e.evicted_pair, e.evicted_reentry_value, e.new_pair, e.new_candidate_value, e.delta, e.swap_cost, e.trim_pct, e.reason],
  );
}
```

**Step 3: Wire into TradingLoop rebalancing block**

After successful rebalance execution, add:

```typescript
insertRebalancingEvent({
  cycle_id: cycleId,
  action_type: rebalanceResult.action,
  evicted_pair: rebalanceResult.evictPair,
  evicted_reentry_value: positionsScored.find(p => p.pair === rebalanceResult.evictPair)?.reentryValue,
  new_pair: decision.pair,
  new_candidate_value: candidateValue,
  delta: rebalanceResult.delta,
  swap_cost: rebalanceResult.swapCost,
  trim_pct: rebalanceResult.trimPct,
}).catch(e => console.error('[DB] rebalancing event error:', e.message));
```

**Step 4: Commit**

```bash
git add src/db/repository.ts
git commit -m "feat(db): portfolio_rebalancing_events table and repository function"
```

---

### Task 8: End-to-end verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Build check**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Deploy to VM with `allocation.enabled: false`**

The feature is behind a feature flag. Deploy without enabling. Monitor logs for a few cycles to ensure no regression.

Run: `npm run deploy`

**Step 4: Enable on VM**

After verifying no regression, add to `config.yaml` on VM:

```yaml
allocation:
  enabled: true
  minFreeMarginPct: 15
  maxRebalancesPerHour: 2
  minHoldBeforeEvictMinutes: 30
  tpProgressLockThreshold: 0.8
```

Then: `pm2 restart indic-bot`

**Step 5: Monitor first rebalancing events**

Watch logs: `pm2 logs indic-bot | grep Allocator`

Expected output patterns:
- `[Allocator] swap_full: evict ETHUSDT (reentry=20.5) → open LINKUSDT (value=60.3) delta=34.8`
- `[Allocator] Skip: no_profitable_swap (candidate=25.3)`

**Step 6: Commit config if needed**

```bash
git add config.yaml
git commit -m "feat(config): enable portfolio allocator with conservative defaults"
```

---

## Summary of all tasks

| # | Task | Files | Tests |
|---|------|-------|-------|
| 1 | Structured MARGIN_SHORTFALL | `manager.ts` | `manager.test.ts` |
| 2 | Scoring functions | `portfolio-allocator.ts` (new) | `portfolio-allocator.test.ts` (new) |
| 3 | Rebalancing decision engine | `portfolio-allocator.ts` | `portfolio-allocator.test.ts` |
| 4 | Opportunity cache | `opportunity-cache.ts` (new) | `opportunity-cache.test.ts` (new) |
| 5 | Config section | `config.ts` | `portfolio-allocator.test.ts` |
| 6 | Wire into TradingLoop | `trading-loop.ts`, `index.ts` | existing tests |
| 7 | DB table | `repository.ts` | manual |
| 8 | E2E verification | — | all + deploy |

**Not in this plan (Phase 2+):**
- Structured invalidator engine
- Confidence calibration pipeline
- Event-driven reevaluation via WebSocket
- Risk-at-stop position sizing
- State reconciliation layer (Phase 0 — separate plan)
