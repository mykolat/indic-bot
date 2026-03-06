const pnlColor = (v: number) => (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-zinc-300');

interface PnlHeaderProps {
  todayPnl: number;
  todayPct: number;
  weekPnl: number;
  monthPnl: number;
  allTimePnl: number;
  totalProfit: number;
  totalLoss: number;
  onRangeChange: (range: '7D' | '1M' | '3M' | 'ALL') => void;
  selectedRange: '7D' | '1M' | '3M' | 'ALL';
}

export function PnlHeader({
  todayPnl, todayPct, weekPnl, monthPnl, allTimePnl,
  totalProfit, totalLoss, onRangeChange, selectedRange,
}: PnlHeaderProps) {
  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
      <div className="mb-4">
        <div className="text-zinc-400 text-sm mb-1">Today's PnL</div>
        <div className="flex items-baseline gap-3">
          <span className={`text-3xl font-bold font-mono ${pnlColor(todayPct)}`}>
            {todayPct >= 0 ? '+' : ''}{todayPct.toFixed(2)}%
          </span>
          <span className={`text-sm ${pnlColor(todayPnl)}`}>
            {todayPnl >= 0 ? '+' : ''}{todayPnl.toFixed(2)} USD
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        {[
          { label: '7D PnL', value: weekPnl },
          { label: '30D PnL', value: monthPnl },
          { label: 'All-time PnL', value: allTimePnl },
        ].map(({ label, value }) => (
          <div key={label}>
            <div className="text-zinc-500 text-xs">{label}</div>
            <div className={`text-lg font-mono font-semibold ${pnlColor(value)}`}>
              {value >= 0 ? '+' : ''}{value.toFixed(2)}
            </div>
            <div className={`text-xs ${pnlColor(value)}`}>{value.toFixed(2)} USD</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mb-3">
        {(['7D', '1M', '3M', 'ALL'] as const).map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`text-xs px-3 py-1 rounded ${
              selectedRange === r ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="border-t border-zinc-800 pt-3 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-400">Total Profit</span>
          <span className="text-green-400 font-mono">{totalProfit.toFixed(2)} USD</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Total Loss</span>
          <span className="text-red-400 font-mono">{totalLoss.toFixed(2)} USD</span>
        </div>
        <div className="flex justify-between font-semibold">
          <span className="text-zinc-300">Net Profit/Loss</span>
          <span className={`font-mono ${pnlColor(totalProfit - totalLoss)}`}>
            {(totalProfit - totalLoss).toFixed(2)} USD
          </span>
        </div>
      </div>
    </div>
  );
}
