import { motion } from 'framer-motion';
import { PersonaVoteCard } from './PersonaVoteCard';
import { JudgeVerdictCard } from './JudgeVerdictCard';

interface RoundPersona {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
}

interface RoundSectionProps {
  round: number;
  personas: RoundPersona[];
  judgeRawResponse?: string;
  isFinalRound: boolean;
  blackboardSignals?: { bullish: string[]; bearish: string[]; neutral: string[] };
  blackboardRisks?: string[];
}

const ROUND_LABELS: Record<number, string> = { 1: 'Analysis', 2: 'Conflict Resolution', 3: 'Deep Dive', 4: 'Final Round' };

export function RoundSection({ round, personas, judgeRawResponse, isFinalRound, blackboardSignals, blackboardRisks }: RoundSectionProps) {
  return (
    <div className="space-y-4">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-surface-3 border border-border flex items-center justify-center">
            <span className="text-[10px] font-mono font-bold text-accent">{round}</span>
          </div>
          <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">{ROUND_LABELS[round] ?? `Round ${round}`}</span>
        </div>
        <div className="flex-1 h-px bg-border" />
        <span className="text-[10px] text-zinc-600 font-mono">{personas.length} experts</span>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {personas.map((p, i) => (
          <PersonaVoteCard key={`${p.persona}-${i}`} persona={p.persona} vote={p.vote} confidence={p.confidence} reasoning={p.reasoning} probability={p.probability} conflictsWith={p.conflictsWith} />
        ))}
      </div>

      {blackboardSignals && (blackboardSignals.bullish.length > 0 || blackboardSignals.bearish.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {blackboardSignals.bullish.map(s => <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/30 text-green-400 font-mono">{s.replace(/_/g, ' ')}</span>)}
          {blackboardSignals.bearish.map(s => <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/30 text-red-400 font-mono">{s.replace(/_/g, ' ')}</span>)}
          {blackboardSignals.neutral.map(s => <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 font-mono">{s.replace(/_/g, ' ')}</span>)}
        </div>
      )}

      {blackboardRisks && blackboardRisks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {blackboardRisks.map(r => <span key={r} className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-900/20 text-yellow-500/80 font-mono">{r.replace(/_/g, ' ')}</span>)}
        </div>
      )}

      {judgeRawResponse && <JudgeVerdictCard rawResponse={judgeRawResponse} isIntermediate={!isFinalRound} />}
    </div>
  );
}
