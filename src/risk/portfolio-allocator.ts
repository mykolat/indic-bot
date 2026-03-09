import type { TradeDecision } from './manager.js';

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

  // Stagnation: penalize positions held for hours with poor progress
  let stagnationPenalty = 0;
  if (input.heldHours > 2 && input.tpProgress < 0.2) {
    stagnationPenalty = Math.min(0.6, (input.heldHours - 2) * 0.15);
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

// --- Rebalancing decision engine ---

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
