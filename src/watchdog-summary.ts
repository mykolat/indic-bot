import type { DbMarketSnapshot } from './db/types.js';
import type { OpenPositionContext } from './db/repository.js';

export function buildWatchdogSummary(
  pair: string,
  snapshots: DbMarketSnapshot[],
  posCtx: OpenPositionContext | undefined,
): string {
  if (snapshots.length === 0) return `${pair}: no data since last Brain cycle`;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const priceDelta = ((Number(last.mark_price) - Number(first.mark_price)) / Number(first.mark_price) * 100).toFixed(1);
  const sign = Number(priceDelta) >= 0 ? '+' : '';
  const minutes = Math.round((new Date(last.created_at!).getTime() - new Date(first.created_at!).getTime()) / 60000);

  let summary = `${pair}: ${sign}${priceDelta}% over ${minutes}m (${snapshots.length} snapshots)`;

  if (first.open_interest && last.open_interest) {
    const oiDelta = ((Number(last.open_interest) - Number(first.open_interest)) / Number(first.open_interest) * 100).toFixed(1);
    summary += ` | OI ${Number(oiDelta) >= 0 ? '+' : ''}${oiDelta}%`;
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
