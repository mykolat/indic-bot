export interface SlRangeInput {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  atrPct: number; // ATR as % of price (e.g. 1.5 = 1.5%)
}

export interface SlRange {
  maxSlPrice: number;       // Tightest allowed SL price
  minSlDistancePct: number; // Min distance from current price as %
  tier: string;             // Description of current tier
}

/**
 * Tiered SL tightening rules.
 *
 * Profit tiers (unrealized PnL %):
 * - <5%:     No tightening. Keep original SL.
 * - 5-10%:   Move SL to breakeven (entry price) max.
 * - 10-20%:  Lock 40% of profit.
 * - 20%+:    Lock 60% of profit.
 *
 * SL must always be >= 1.5x ATR away from current price.
 */
export function computeAllowedSlRange(input: SlRangeInput): SlRange {
  const { side, entryPrice, currentPrice, atrPct } = input;

  const profitPct = side === 'LONG'
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;

  const minDistancePct = atrPct * 1.5;
  const atrDistance = currentPrice * minDistancePct / 100;

  // Determine tier and lock ratio
  let lockRatio: number;
  let tier: string;

  if (profitPct < 5) {
    tier = 'no_tightening (<5% profit)';
    // No tightening allowed — SL stays at entry or worse
    return { maxSlPrice: entryPrice, minSlDistancePct: minDistancePct, tier };
  } else if (profitPct < 10) {
    lockRatio = 0.05; // breakeven = lock 5% of profit (buffer above entry)
    tier = 'breakeven (5-10% profit)';
  } else if (profitPct < 20) {
    lockRatio = 0.4;
    tier = 'lock_40pct (10-20% profit)';
  } else {
    lockRatio = 0.6;
    tier = 'lock_60pct (20%+ profit)';
  }

  // SL price from profit lock
  let slFromProfit: number;
  if (side === 'LONG') {
    slFromProfit = entryPrice + (currentPrice - entryPrice) * lockRatio;
  } else {
    slFromProfit = entryPrice - (entryPrice - currentPrice) * lockRatio;
  }

  // SL price from ATR minimum distance
  let slFromAtr: number;
  if (side === 'LONG') {
    slFromAtr = currentPrice - atrDistance;
  } else {
    slFromAtr = currentPrice + atrDistance;
  }

  // Take the more conservative (further from current price)
  let maxSlPrice: number;
  if (side === 'LONG') {
    maxSlPrice = Math.min(slFromProfit, slFromAtr);
  } else {
    maxSlPrice = Math.max(slFromProfit, slFromAtr);
  }

  return { maxSlPrice, minSlDistancePct: minDistancePct, tier };
}
