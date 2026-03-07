import { motion } from 'framer-motion';
import { VerdictBar } from './VerdictBar.js';
import { SemiGauge } from './SemiGauge.js';
import { PersonaDots } from './PersonaDots.js';
import { RiskSummary } from './RiskSummary.js';

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

  const allBullish = personaSignals.flatMap(p => p.signals.bullish ?? []);
  const allBearish = personaSignals.flatMap(p => p.signals.bearish ?? []);
  const uniqueBull = [...new Set(allBullish.map(s => s.toLowerCase().replace(/_/g, ' ')))];
  const uniqueBear = [...new Set(allBearish.map(s => s.toLowerCase().replace(/_/g, ' ')))];

  return (
    <div className="space-y-3">
      {/* Round divider */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 py-1">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full border border-border flex items-center justify-center" style={{ backgroundColor: 'var(--surface-3)' }}>
            <span className="text-[9px] font-mono font-bold text-accent">{round}</span>
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-faint)' }}>
            {ROUND_LABELS[round] ?? `Round ${round}`}
          </span>
        </div>
        <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
      </motion.div>

      {/* 2. Verdict */}
      {judgeRawResponse && (
        <VerdictBar rawResponse={judgeRawResponse} isIntermediate={!isFinalRound} />
      )}

      {/* 3. Bull/Bear Gauge */}
      {(uniqueBull.length > 0 || uniqueBear.length > 0) && (
        <SemiGauge
          bullCount={uniqueBull.length}
          bearCount={uniqueBear.length}
          bullSignals={uniqueBull}
          bearSignals={uniqueBear}
        />
      )}

      {/* 4. Persona dots */}
      <PersonaDots votes={personas} />

      {/* 5. Risks */}
      <RiskSummary risks={risks} />
    </div>
  );
}
