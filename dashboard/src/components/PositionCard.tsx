interface Position {
  pair: string;
  side: string;
  fill_price: number;
  quantity: number;
  leverage: number;
  sl_price: number;
  tp_price: number;
  entry_thesis: string;
  opened_at: string;
}

function SlTpBar({ entry, sl, tp, side }: { entry: number; sl: number; tp: number; side: string }) {
  // For SHORT: SL is above entry, TP is below entry
  // For LONG: SL is below entry, TP is above entry
  // We always show SL on left, TP on right, entry position relative
  const isLong = side === 'BUY';
  const low = isLong ? sl : tp;
  const high = isLong ? tp : sl;
  const range = high - low;
  if (range <= 0) return null;

  const entryPct = ((entry - low) / range) * 100;
  const clampedEntry = Math.max(2, Math.min(98, entryPct));

  // Color: left of entry = loss zone, right of entry = profit zone (for LONG)
  // For SHORT it's reversed visually but we keep SL left, TP right
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
        <span>SL ${sl.toFixed(4)}</span>
        <span>TP ${tp.toFixed(4)}</span>
      </div>
      <div className="relative h-2 rounded-full overflow-hidden bg-zinc-800">
        {/* Loss zone (SL side) */}
        <div
          className="absolute inset-y-0 left-0 bg-red-900/60 rounded-l-full"
          style={{ width: `${clampedEntry}%` }}
        />
        {/* Profit zone (TP side) */}
        <div
          className="absolute inset-y-0 right-0 bg-green-900/60 rounded-r-full"
          style={{ width: `${100 - clampedEntry}%` }}
        />
        {/* Entry marker */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white border-2 border-zinc-600 shadow"
          style={{ left: `${clampedEntry}%`, marginLeft: '-5px' }}
        />
      </div>
    </div>
  );
}

export function PositionCard({ position }: { position: Position }) {
  const isShort = position.side !== 'BUY';
  const arrow = isShort ? '↓' : '↑';
  const sideLabel = isShort ? 'SHORT' : 'LONG';
  const sideColor = isShort ? 'text-red-400' : 'text-green-400';

  const entry = Number(position.fill_price);
  const sl = Number(position.sl_price);
  const tp = Number(position.tp_price);

  // Estimate unrealized PnL from entry vs midpoint (we don't have current price here)
  // Just show entry info, PnL comes from live data if available

  return (
    <div className="bg-surface-1 rounded-xl border border-border p-4 hover:border-zinc-600 transition-colors">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${sideColor}`}>{arrow}</span>
          <span className="font-mono font-semibold text-white">{position.pair}</span>
          <span className={`text-sm font-medium ${sideColor}`}>{sideLabel}</span>
          <span className="text-zinc-500 text-sm">{position.leverage}x</span>
          <span className="text-zinc-400 text-sm font-mono">@${entry.toFixed(4)}</span>
        </div>
        <div className="text-zinc-500 text-xs">
          {new Date(position.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      {/* SL/TP progress bar */}
      <SlTpBar entry={entry} sl={sl} tp={tp} side={position.side} />

      {/* Thesis */}
      {position.entry_thesis && (
        <div className="mt-2 text-xs text-zinc-500 leading-relaxed line-clamp-2">
          {position.entry_thesis}
        </div>
      )}
    </div>
  );
}

export function PositionCardList({ positions }: { positions: Position[] }) {
  if (!positions.length) {
    return <div className="text-zinc-500 text-sm p-4">No open positions</div>;
  }
  return (
    <div className="space-y-3">
      {positions.map((p) => (
        <PositionCard key={p.pair + p.opened_at} position={p} />
      ))}
    </div>
  );
}
