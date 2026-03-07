import { motion } from 'framer-motion';

interface TradeEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

const EVENT_CONFIG: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  decision: { color: 'text-blue-400', bg: 'bg-blue-500', icon: '\u{1F4CB}', label: 'Decision' },
  risk:     { color: 'text-yellow-400', bg: 'bg-yellow-500', icon: '\u{1F6E1}\uFE0F', label: 'Risk' },
  execution:{ color: 'text-green-400', bg: 'bg-green-500', icon: '\u{26A1}', label: 'Execution' },
  close:    { color: 'text-purple-400', bg: 'bg-purple-500', icon: '\u{1F3C1}', label: 'Close' },
  error:    { color: 'text-red-400', bg: 'bg-red-500', icon: '\u{26A0}\uFE0F', label: 'Error' },
};

function formatEventDetail(ev: TradeEvent): string {
  switch (ev.type) {
    case 'decision':
      return `${ev.data.pair} ${ev.data.action} conf:${ev.data.confidence} — ${ev.data.reasoning?.slice(0, 200) ?? ''}`;
    case 'risk':
      return ev.data.passed ? 'Passed risk validation' : `Rejected: ${ev.data.rejection_reason}`;
    case 'execution':
      return `Filled @ $${ev.data.fill_price} qty:${ev.data.quantity} lev:${ev.data.leverage}x SL:$${ev.data.sl_price} TP:$${ev.data.tp_price}`;
    case 'close': {
      const pnl = Number(ev.data.pnl_usd);
      const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${ev.data.pnl_pct}%)`;
      return `${ev.data.exit_reason} — ${pnlStr}`;
    }
    case 'error':
      return `${ev.data.code}: ${ev.data.message}`;
    default:
      return JSON.stringify(ev.data).slice(0, 200);
  }
}

export function TradeTimeline({ events }: { events: TradeEvent[] }) {
  if (events.length === 0) {
    return <div className="text-zinc-600 text-sm py-4">Loading timeline...</div>;
  }

  return (
    <div className="space-y-0">
      {events.map((ev, i) => {
        const cfg = EVENT_CONFIG[ev.type] ?? EVENT_CONFIG.decision;
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className="flex gap-3"
          >
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center w-5">
              <div className={`w-2.5 h-2.5 rounded-full ${cfg.bg} ring-2 ring-surface-0 shrink-0 mt-1`} />
              {i < events.length - 1 && <div className="w-px flex-1 bg-border" />}
            </div>

            {/* Content */}
            <div className="pb-5 flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-zinc-600 font-mono">
                  {new Date(ev.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={`text-xs font-semibold ${cfg.color}`}>
                  {cfg.label}
                </span>
              </div>
              <p className="text-[13px] text-zinc-400 leading-relaxed">
                {formatEventDetail(ev)}
              </p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
