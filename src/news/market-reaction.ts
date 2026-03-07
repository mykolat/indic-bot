import type { DbMarketSnapshot } from '../db/types.js';

export type MarketVerdict = 'CONFIRMS' | 'FADES' | 'IGNORES';

export interface MarketReaction {
  verdict: MarketVerdict;
  priceDisplacementPct: number;
  oiChangePct: number;
  fundingFlipped: boolean;
  imbalanceShift: number;
  summary: string;
}

const DISPLACEMENT_THRESHOLD = 0.5; // percent

function zeros(): MarketReaction {
  return {
    verdict: 'IGNORES',
    priceDisplacementPct: 0,
    oiChangePct: 0,
    fundingFlipped: false,
    imbalanceShift: 0,
    summary: 'IGNORES: insufficient data',
  };
}

export function computeMarketReaction(
  snapshots: DbMarketSnapshot[],
  eventTime: string,
  claimDirection?: 'bullish' | 'bearish' | 'neutral',
): MarketReaction {
  const eventTs = new Date(eventTime).getTime();

  const before = snapshots
    .filter((s) => s.created_at && new Date(s.created_at).getTime() < eventTs)
    .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());

  const after = snapshots
    .filter((s) => s.created_at && new Date(s.created_at).getTime() >= eventTs)
    .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());

  if (before.length === 0 || after.length === 0) return zeros();

  const baseline = before[before.length - 1];
  const latest = after[after.length - 1];

  // Price displacement
  const priceDisplacementPct =
    ((latest.mark_price - baseline.mark_price) / baseline.mark_price) * 100;

  // OI change
  const oiChangePct =
    baseline.open_interest && latest.open_interest
      ? ((latest.open_interest - baseline.open_interest) / baseline.open_interest) * 100
      : 0;

  // Funding flip
  const fundingFlipped =
    baseline.funding_rate != null &&
    latest.funding_rate != null &&
    Math.sign(baseline.funding_rate) !== Math.sign(latest.funding_rate) &&
    baseline.funding_rate !== 0 &&
    latest.funding_rate !== 0;

  // Imbalance shift
  const imbalanceShift =
    baseline.imbalance_pct != null && latest.imbalance_pct != null
      ? latest.imbalance_pct - baseline.imbalance_pct
      : 0;

  // Verdict
  let verdict: MarketVerdict;

  if (Math.abs(priceDisplacementPct) < DISPLACEMENT_THRESHOLD) {
    verdict = 'IGNORES';
  } else if (!claimDirection || claimDirection === 'neutral') {
    // Any significant move counts as confirmation when direction is unknown/neutral
    verdict = 'CONFIRMS';
  } else {
    const priceAligned =
      (claimDirection === 'bullish' && priceDisplacementPct > 0) ||
      (claimDirection === 'bearish' && priceDisplacementPct < 0);
    verdict = priceAligned ? 'CONFIRMS' : 'FADES';
  }

  // Summary
  const parts: string[] = [
    `price ${priceDisplacementPct >= 0 ? '+' : ''}${priceDisplacementPct.toFixed(2)}%`,
    `OI ${oiChangePct >= 0 ? '+' : ''}${oiChangePct.toFixed(1)}%`,
  ];
  if (fundingFlipped) parts.push('funding flipped');
  if (imbalanceShift !== 0) parts.push(`OBI shift ${imbalanceShift >= 0 ? '+' : ''}${imbalanceShift.toFixed(0)}%`);

  const summary = `${verdict}: ${parts.join(', ')}`;

  return {
    verdict,
    priceDisplacementPct,
    oiChangePct,
    fundingFlipped,
    imbalanceShift,
    summary,
  };
}
