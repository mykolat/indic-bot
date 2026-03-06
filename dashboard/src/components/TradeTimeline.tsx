interface TradeEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

const colorMap: Record<string, string> = {
  decision: 'border-blue-500',
  risk: 'border-yellow-500',
  execution: 'border-green-500',
  close: 'border-purple-500',
  error: 'border-red-500',
};

export function TradeTimeline({ events }: { events: TradeEvent[] }) {
  return (
    <div className="space-y-0">
      {events.map((ev, i) => (
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className={`w-3 h-3 rounded-full border-2 ${colorMap[ev.type]} bg-zinc-950`} />
            {i < events.length - 1 && <div className="w-px flex-1 bg-zinc-700" />}
          </div>
          <div className="pb-4 text-sm">
            <div className="flex gap-2 items-baseline">
              <span className="text-zinc-500 font-mono text-xs">
                {new Date(ev.time).toLocaleTimeString()}
              </span>
              <span className="text-zinc-300 font-semibold capitalize">{ev.type}</span>
            </div>
            <div className="text-zinc-400 text-xs mt-1">
              {ev.type === 'decision' && `${ev.data.pair} ${ev.data.action} conf:${ev.data.confidence} — ${ev.data.reasoning?.slice(0, 120)}...`}
              {ev.type === 'risk' && (ev.data.passed ? 'Passed risk validation' : `Rejected: ${ev.data.rejection_reason}`)}
              {ev.type === 'execution' && `Filled @ $${ev.data.fill_price} qty:${ev.data.quantity} lev:${ev.data.leverage}x SL:$${ev.data.sl_price} TP:$${ev.data.tp_price}`}
              {ev.type === 'close' && `Closed PnL: ${ev.data.pnl_pct}% ($${ev.data.pnl_usd}) reason: ${ev.data.exit_reason}`}
              {ev.type === 'error' && `${ev.data.code}: ${ev.data.message}`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
