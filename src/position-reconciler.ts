export interface DbOpenPosition {
  id: number;
  pair: string;
  side: string; // 'BUY' | 'SELL'
}

/**
 * Compare DB "open" positions (no trade_closes) with actual Binance positions.
 * Returns DB positions that no longer exist on Binance (= ghost positions).
 */
export function detectGhostPositions(
  dbOpen: DbOpenPosition[],
  binancePositions: { pair: string; side: 'LONG' | 'SHORT' }[],
): DbOpenPosition[] {
  const normalizedSet = new Set(
    binancePositions.map(p => {
      const side = p.side === 'LONG' ? 'BUY' : 'SELL';
      return `${p.pair}:${side}`;
    }),
  );
  return dbOpen.filter(d => !normalizedSet.has(`${d.pair}:${d.side}`));
}
