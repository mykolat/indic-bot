import type { DbMarketSnapshot } from './db/types.js';
import type { OpenPositionContext } from './db/repository.js';
import { interpretFundingRate, interpretOIDivergence, interpretOBI } from './market/signals.js';

export function buildWatchdogSummary(
  pair: string,
  snapshots: DbMarketSnapshot[],
  posCtx: OpenPositionContext | undefined,
): string {
  if (snapshots.length === 0) return `${pair}: no data since last Brain cycle`;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const firstPrice = Number(first.mark_price);
  const lastPrice = Number(last.mark_price);
  const priceDelta = firstPrice > 0
    ? ((lastPrice - firstPrice) / firstPrice * 100).toFixed(1)
    : '0.0';
  const sign = Number(priceDelta) >= 0 ? '+' : '';
  const minutes = Math.round((new Date(last.created_at!).getTime() - new Date(first.created_at!).getTime()) / 60000);

  let summary = `${pair}: ${sign}${priceDelta}% over ${minutes}m (${snapshots.length} snapshots)`;

  if (first.open_interest && last.open_interest) {
    const firstOI = Number(first.open_interest);
    const lastOI = Number(last.open_interest);
    const oiDelta = firstOI > 0
      ? ((lastOI - firstOI) / firstOI * 100).toFixed(1)
      : '0.0';
    summary += ` | OI ${Number(oiDelta) >= 0 ? '+' : ''}${oiDelta}%`;
    const oiDeltaNum = Number(oiDelta);
    const priceDeltaNum = Number(priceDelta);
    const divergence = interpretOIDivergence(priceDeltaNum, oiDeltaNum);
    if (divergence.label !== 'NEUTRAL') {
      summary += ` (${divergence.label})`;
    }
  }

  // Order Book Imbalance
  if (last.imbalance_pct != null) {
    const obi = Number(last.imbalance_pct);
    if (!isNaN(obi)) {
      const obiSignal = interpretOBI(obi);
      summary += ` | OBI ${obi >= 0 ? '+' : ''}${obi.toFixed(0)}%`;
      if (obiSignal.label !== 'BALANCED') {
        summary += ` (${obiSignal.label})`;
      }
    }
  }

  // Funding rate
  if (first.funding_rate != null && last.funding_rate != null) {
    const fr0 = Number(first.funding_rate);
    const fr1 = Number(last.funding_rate);
    if (fr0 !== 0 && Math.sign(fr0) !== Math.sign(fr1)) {
      summary += ` | Funding flipped ${fr0 > 0 ? '+→-' : '-→+'}`;
    } else {
      const frBps = (fr1 * 10000).toFixed(1);
      summary += ` | Funding ${Number(frBps) >= 0 ? '+' : ''}${frBps}bps`;
      const fundingSignal = interpretFundingRate(fr1);
      if (fundingSignal.label !== 'NEUTRAL') {
        summary += ` (${fundingSignal.label})`;
      }
    }
  }

  // Long/Short ratio
  if (first.long_short_ratio != null && last.long_short_ratio != null) {
    summary += ` | L/S ${Number(first.long_short_ratio).toFixed(2)}→${Number(last.long_short_ratio).toFixed(2)}`;
  }

  if (posCtx) {
    const currentPrice = Number(last.mark_price);
    const slHit = posCtx.side === 'BUY'
      ? currentPrice <= posCtx.sl_price
      : currentPrice >= posCtx.sl_price;
    const tpHit = posCtx.side === 'BUY'
      ? currentPrice >= posCtx.tp_price
      : currentPrice <= posCtx.tp_price;

    summary += ` | SL $${posCtx.sl_price} ${slHit ? 'HIT' : 'NOT hit'}`;
    summary += ` | TP $${posCtx.tp_price} ${tpHit ? 'HIT' : 'NOT hit'}`;
  }

  return summary;
}
