import { motion } from 'framer-motion';
import { VOTE_COLORS } from '../../lib/theme';

interface JudgeVerdictCardProps {
  rawResponse: string;
  isIntermediate?: boolean;
}

interface ParsedDecision {
  pair: string;
  action: string;
  confidence: number;
  reasoning: string;
  leverage?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  size_pct?: number;
}

function parseJudgeResponse(raw: string): { decisions: ParsedDecision[]; nextCheck?: number; verdict?: string; continues?: boolean } | null {
  try {
    const parsed = JSON.parse(raw);
    return { decisions: parsed.decisions ?? [], nextCheck: parsed.next_check_minutes, verdict: parsed.verdict, continues: parsed.continue };
  } catch {
    const match = raw.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return { decisions: parsed.decisions ?? [], nextCheck: parsed.next_check_minutes, verdict: parsed.verdict, continues: parsed.continue };
      } catch { /* */ }
    }
  }
  return null;
}

export function JudgeVerdictCard({ rawResponse, isIntermediate }: JudgeVerdictCardProps) {
  const parsed = parseJudgeResponse(rawResponse);
  if (!parsed) {
    return (
      <div className="bg-surface-2 rounded-lg border border-border p-4">
        <span className="text-xs text-zinc-600">Judge response (unparseable)</span>
        <pre className="text-[11px] text-zinc-500 font-mono mt-2 whitespace-pre-wrap max-h-40 overflow-y-auto">{rawResponse}</pre>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}
      className={`rounded-xl border overflow-hidden ${isIntermediate ? 'bg-surface-2 border-border' : 'bg-surface-1 border-accent-dim'}`}>
      {!isIntermediate && <div className="h-0.5 bg-gradient-to-r from-accent via-judge to-accent" />}
      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-base">{'\u2696\uFE0F'}</span>
          <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">{isIntermediate ? 'Intermediate Verdict' : 'Final Verdict'}</span>
          {parsed.continues && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-mono">CONTINUE</span>}
        </div>
        {parsed.decisions.map((d, i) => {
          const actionColor = VOTE_COLORS[d.action] ?? '#a1a1aa';
          return (
            <div key={i} className="mb-4 last:mb-0">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-2xl font-mono font-bold" style={{ color: actionColor }}>{d.action}</span>
                <span className="text-lg font-mono text-zinc-300">{d.pair}</span>
                <span className="text-sm font-mono text-zinc-500">conf:{d.confidence}</span>
              </div>
              {(d.leverage || d.stop_loss_pct || d.take_profit_pct) && (
                <div className="flex gap-4 mb-2 text-xs font-mono text-zinc-500">
                  {d.leverage && <span>Lev: {d.leverage}x</span>}
                  {d.size_pct != null && <span>Size: {d.size_pct}%</span>}
                  {d.stop_loss_pct && <span>SL: {d.stop_loss_pct}%</span>}
                  {d.take_profit_pct && <span>TP: {d.take_profit_pct}%</span>}
                </div>
              )}
              <p className="text-sm text-zinc-400 leading-relaxed">{d.reasoning}</p>
            </div>
          );
        })}
        {parsed.verdict && (
          <div className="mt-3 pt-3 border-t border-border-subtle">
            <span className="text-xs text-zinc-600">Verdict: </span>
            <span className="text-xs text-zinc-400 font-mono">{parsed.verdict}</span>
          </div>
        )}
        {parsed.nextCheck && <div className="mt-2 text-[10px] text-zinc-600 font-mono">Next check: {parsed.nextCheck} min</div>}
      </div>
    </motion.div>
  );
}
