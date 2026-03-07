import { motion } from 'framer-motion';

interface TradeEvent {
  type: 'context' | 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

const EVENT_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  context:  { color: 'text-zinc-400', bg: 'bg-zinc-500', label: 'Market Context' },
  decision: { color: 'text-blue-400', bg: 'bg-blue-500', label: 'Decision' },
  risk:     { color: 'text-yellow-400', bg: 'bg-yellow-500', label: 'Risk Check' },
  execution:{ color: 'text-green-400', bg: 'bg-green-500', label: 'Execution' },
  close:    { color: 'text-purple-400', bg: 'bg-purple-500', label: 'Close' },
  error:    { color: 'text-red-400', bg: 'bg-red-500', label: 'Error' },
};

function fgLabel(v: number): string {
  if (v < 25) return 'Extreme Fear';
  if (v < 45) return 'Fear';
  if (v < 56) return 'Neutral';
  if (v < 76) return 'Greed';
  return 'Extreme Greed';
}

function ContextDetail({ data }: { data: Record<string, any> }) {
  const fg = data.fear_greed_value;
  const vol = Number(data.volume_ratio ?? 0);
  const bal = Number(data.balance ?? 0);
  const pnl = Number(data.session_pnl ?? 0);
  const conf = data.confluence_score;
  const factors = data.confluence_factors;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
        <div><span className="text-zinc-600">Balance</span> <span className="text-zinc-300 font-mono">${bal.toFixed(2)}</span></div>
        <div><span className="text-zinc-600">Session</span> <span className={`font-mono ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</span></div>
        <div><span className="text-zinc-600">Fear & Greed</span> <span className={`font-mono ${fg < 25 ? 'text-red-400' : fg > 60 ? 'text-green-400' : 'text-yellow-400'}`}>{fg} {fgLabel(fg)}</span></div>
        <div><span className="text-zinc-600">Volume</span> <span className={`font-mono ${vol > 1.5 ? 'text-green-400' : 'text-zinc-300'}`}>{vol.toFixed(2)}x</span></div>
        <div><span className="text-zinc-600">Regime</span> <span className="text-zinc-300">{data.regime} <span className="text-zinc-600">{data.regime_confidence}%</span></span></div>
        <div><span className="text-zinc-600">Layer</span> <span className="text-zinc-300 font-mono">{data.layer}</span></div>
        {conf != null && (
          <div><span className="text-zinc-600">Confluence</span> <span className="text-zinc-300 font-mono">{conf}/5</span> {factors?.length > 0 && <span className="text-zinc-600">{factors.join(', ')}</span>}</div>
        )}
        {data.news_sentiment && (
          <div><span className="text-zinc-600">News</span> <span className="text-zinc-300">{data.news_sentiment}</span> {data.news_count && <span className="text-zinc-600">({data.news_count} articles)</span>}</div>
        )}
      </div>
      {data.filter_warning && (
        <div className="text-[11px] text-yellow-500/80 font-mono">{data.filter_warning}</div>
      )}
      {data.news_risks?.length > 0 && (
        <div className="text-[11px] text-red-400/70">Risks: {data.news_risks.slice(0, 2).join(' | ')}</div>
      )}
    </div>
  );
}

function formatEventDetail(ev: TradeEvent): string {
  switch (ev.type) {
    case 'decision':
      return `${ev.data.pair} ${ev.data.action} conf:${ev.data.confidence} — ${ev.data.reasoning?.slice(0, 200) ?? ''}`;
    case 'risk': {
      if (!ev.data.passed) return `Rejected: ${ev.data.rejection_reason}`;
      const checks = [
        'confidence \u2265 55%',
        'leverage limits',
        'position size',
        'stop-loss range',
        'margin exposure',
        'no duplicate',
      ];
      if (ev.data.shutdown_triggered) return 'Shutdown triggered — session loss limit reached';
      return `Passed: ${checks.join(' \u00b7 ')}`;
    }
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
    return (
      <div className="space-y-4 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-surface-3 mt-1" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-surface-3 rounded w-24" />
              <div className="h-3 bg-surface-2 rounded w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {events.map((ev, i) => {
        const cfg = EVENT_CONFIG[ev.type] ?? EVENT_CONFIG.decision;
        const isContext = ev.type === 'context';
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className="flex gap-3"
          >
            <div className="flex flex-col items-center w-5">
              <div className={`w-2.5 h-2.5 rounded-full ${cfg.bg} ring-2 ring-surface-0 shrink-0 mt-1`} />
              {i < events.length - 1 && <div className="w-px flex-1 bg-border" />}
            </div>

            <div className="pb-5 flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-zinc-500 font-mono">
                  {new Date(ev.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={`text-xs font-semibold ${cfg.color}`}>
                  {cfg.label}
                </span>
              </div>
              {isContext ? (
                <ContextDetail data={ev.data} />
              ) : (
                <p className="text-[13px] text-zinc-400 leading-relaxed">
                  {formatEventDetail(ev)}
                </p>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
