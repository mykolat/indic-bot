import { VOTE_COLORS } from '../../lib/theme';

interface VerdictBarProps {
  rawResponse: string;
  isIntermediate?: boolean;
}

interface ParsedVerdict {
  action: string;
  pair?: string;
  confidence?: number;
  reasoning?: string;
  verdict?: string;
  nextCheck?: number;
  continues?: boolean;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  sizePct?: number;
}

function parseVerdict(raw: string): ParsedVerdict | null {
  try {
    const parsed = JSON.parse(raw);
    const d = parsed.decisions?.[0];
    if (typeof d === 'string') {
      return {
        action: d,
        verdict: parsed.verdict,
        nextCheck: parsed.next_check_minutes,
        continues: parsed.continue,
      };
    }
    if (d?.action) {
      return {
        action: d.action,
        pair: d.pair,
        confidence: d.confidence,
        reasoning: d.reasoning,
        verdict: parsed.verdict,
        nextCheck: parsed.next_check_minutes,
        continues: parsed.continue,
        leverage: d.leverage,
        stopLoss: d.stop_loss_pct,
        takeProfit: d.take_profit_pct,
        sizePct: d.size_pct,
      };
    }
    if (parsed.verdict) {
      return { action: 'HOLD', verdict: parsed.verdict, nextCheck: parsed.next_check_minutes, continues: parsed.continue };
    }
  } catch { /* */ }
  return null;
}

export function VerdictBar({ rawResponse, isIntermediate }: VerdictBarProps) {
  const v = parseVerdict(rawResponse);
  if (!v) return null;

  const color = VOTE_COLORS[v.action] ?? '#71717a';
  const showParams = v.action !== 'HOLD' && (v.leverage || v.stopLoss || v.takeProfit);

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ borderColor: `${color}30`, backgroundColor: `${color}08` }}
    >
      {!isIntermediate && <div className="h-0.5" style={{ backgroundColor: color }} />}
      <div className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isIntermediate && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-mono">CONTINUE</span>
            )}
            <span className="text-2xl font-mono font-bold" style={{ color }}>{v.action}</span>
            {v.pair && <span className="text-lg font-mono text-zinc-300">{v.pair}</span>}
            {v.confidence != null && v.confidence > 0 && (
              <span className="text-sm font-mono text-zinc-500">conf:{v.confidence}</span>
            )}
          </div>
          {v.nextCheck && (
            <span className="text-[10px] text-zinc-600 font-mono">next: {v.nextCheck} min</span>
          )}
        </div>

        {showParams && (
          <div className="flex gap-4 mt-2 text-xs font-mono text-zinc-500">
            {v.leverage ? <span>Lev: {v.leverage}x</span> : null}
            {v.sizePct ? <span>Size: {v.sizePct}%</span> : null}
            {v.stopLoss ? <span>SL: {v.stopLoss}%</span> : null}
            {v.takeProfit ? <span>TP: {v.takeProfit}%</span> : null}
          </div>
        )}

        {v.reasoning && (
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">{v.reasoning}</p>
        )}
        {v.verdict && !v.reasoning && (
          <p className="text-xs text-zinc-500 mt-1 font-mono">{v.verdict.replace(/_/g, ' ')}</p>
        )}
      </div>
    </div>
  );
}
