import { motion } from 'framer-motion';
import { VerdictBar } from './VerdictBar';
import { VoteRow } from './VoteRow';
import { SignalBoard } from './SignalBoard';

interface BlackboardPersona {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  conflictsWith?: Record<string, string> | null;
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
  time?: string;
}

interface BlackboardViewProps {
  round: number;
  personas: BlackboardPersona[];
  judgeRawResponse?: string;
  isFinalRound: boolean;
  risks: string[];
}

const ROUND_LABELS: Record<number, string> = { 1: 'Analysis', 2: 'Conflict Resolution', 3: 'Deep Dive', 4: 'Final Round' };

export function BlackboardView({ round, personas, judgeRawResponse, isFinalRound, risks }: BlackboardViewProps) {
  const personaSignals = personas
    .filter(p => p.signals)
    .map(p => ({ persona: p.persona, signals: p.signals! }));

  return (
    <div className="space-y-3">
      {/* Round divider */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 py-1">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-surface-3 border border-border flex items-center justify-center">
            <span className="text-[9px] font-mono font-bold text-accent">{round}</span>
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            {ROUND_LABELS[round] ?? `Round ${round}`}
          </span>
        </div>
        <div className="flex-1 h-px bg-border" />
      </motion.div>

      {/* 1. Verdict FIRST */}
      {judgeRawResponse && (
        <VerdictBar rawResponse={judgeRawResponse} isIntermediate={!isFinalRound} />
      )}

      {/* 2. Compact votes */}
      <VoteRow votes={personas} />

      {/* 3. Signal board with persona attribution */}
      <SignalBoard personaSignals={personaSignals} risks={risks} />
    </div>
  );
}
