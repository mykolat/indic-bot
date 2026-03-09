import { describe, it, expect } from 'vitest';
import {
  computeEntryModel,
  computeRetainScore,
  computeReentryValue,
  computeCandidateValue,
  evaluateRebalancing,
  type ScoringContext,
  type RebalanceInput,
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

describe('config — allocation section', () => {
  it('loads allocation config with defaults', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const cfg = loadConfig();
    expect(cfg.allocation).toBeDefined();
    expect(cfg.allocation.enabled).toBe(true);
    expect(cfg.allocation.minFreeMarginPct).toBe(15);
    expect(cfg.allocation.maxRebalancesPerHour).toBe(2);
  });
});
