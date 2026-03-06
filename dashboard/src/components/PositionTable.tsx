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

export function PositionTable({ positions }: { positions: Position[] }) {
  if (!positions.length) return <div className="text-zinc-500 p-4">No open positions</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-400 border-b border-zinc-800">
            <th className="text-left p-2">Pair</th>
            <th className="text-left p-2">Side</th>
            <th className="text-right p-2">Entry</th>
            <th className="text-right p-2">Qty</th>
            <th className="text-right p-2">Lev</th>
            <th className="text-right p-2">SL</th>
            <th className="text-right p-2">TP</th>
            <th className="text-left p-2">Thesis</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.pair + p.opened_at} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
              <td className="p-2 font-mono">{p.pair}</td>
              <td className={`p-2 ${p.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                {p.side === 'BUY' ? 'LONG' : 'SHORT'}
              </td>
              <td className="p-2 text-right font-mono">${Number(p.fill_price).toFixed(4)}</td>
              <td className="p-2 text-right font-mono">{p.quantity}</td>
              <td className="p-2 text-right">{p.leverage}x</td>
              <td className="p-2 text-right font-mono">${Number(p.sl_price).toFixed(4)}</td>
              <td className="p-2 text-right font-mono">${Number(p.tp_price).toFixed(4)}</td>
              <td className="p-2 text-zinc-300 max-w-xs truncate">{p.entry_thesis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
