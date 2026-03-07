export interface FundingSignal {
  label: 'NEUTRAL' | 'OVERCROWDED_LONGS' | 'OVERCROWDED_SHORTS' | 'EXTREME_LONGS' | 'EXTREME_SHORTS';
  direction: 'bullish' | 'bearish' | 'neutral';
  raw: number;
}

export function interpretFundingRate(rate: number): FundingSignal {
  const pct = rate * 100; // 0.0001 → 0.01%

  if (pct > 0.1) return { label: 'EXTREME_LONGS', direction: 'bearish', raw: rate };
  if (pct > 0.05) return { label: 'OVERCROWDED_LONGS', direction: 'bearish', raw: rate };
  if (pct < -0.1) return { label: 'EXTREME_SHORTS', direction: 'bullish', raw: rate };
  if (pct < -0.05) return { label: 'OVERCROWDED_SHORTS', direction: 'bullish', raw: rate };
  return { label: 'NEUTRAL', direction: 'neutral', raw: rate };
}

export interface OIDivergenceSignal {
  label: 'TREND_CONTINUATION' | 'SHORT_SQUEEZE' | 'NEW_SHORTS' | 'LONG_CAPITULATION' | 'NEUTRAL';
  direction: 'bullish' | 'bearish' | 'neutral';
}

const OI_THRESHOLD = 0.5;

export function interpretOIDivergence(priceDeltaPct: number, oiDeltaPct: number): OIDivergenceSignal {
  if (Math.abs(priceDeltaPct) < OI_THRESHOLD && Math.abs(oiDeltaPct) < OI_THRESHOLD) {
    return { label: 'NEUTRAL', direction: 'neutral' };
  }

  const priceUp = priceDeltaPct > OI_THRESHOLD;
  const priceDown = priceDeltaPct < -OI_THRESHOLD;
  const oiUp = oiDeltaPct > OI_THRESHOLD;
  const oiDown = oiDeltaPct < -OI_THRESHOLD;

  if (priceUp && oiUp) return { label: 'TREND_CONTINUATION', direction: 'bullish' };
  if (priceUp && oiDown) return { label: 'SHORT_SQUEEZE', direction: 'bearish' };
  if (priceDown && oiUp) return { label: 'NEW_SHORTS', direction: 'bearish' };
  if (priceDown && oiDown) return { label: 'LONG_CAPITULATION', direction: 'bullish' };

  return { label: 'NEUTRAL', direction: 'neutral' };
}

export interface OBISignal {
  label: 'BALANCED' | 'BID_HEAVY' | 'ASK_HEAVY' | 'EXTREME_BID' | 'EXTREME_ASK';
  direction: 'bullish' | 'bearish' | 'neutral';
}

export function interpretOBI(imbalancePct: number): OBISignal {
  if (imbalancePct > 40) return { label: 'EXTREME_BID', direction: 'bullish' };
  if (imbalancePct > 20) return { label: 'BID_HEAVY', direction: 'bullish' };
  if (imbalancePct < -40) return { label: 'EXTREME_ASK', direction: 'bearish' };
  if (imbalancePct < -20) return { label: 'ASK_HEAVY', direction: 'bearish' };
  return { label: 'BALANCED', direction: 'neutral' };
}
