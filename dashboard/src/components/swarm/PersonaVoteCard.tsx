import { useState } from 'react';
import { motion } from 'framer-motion';
import { getPersona, VOTE_COLORS } from '../../lib/theme';

interface PersonaVoteCardProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
}

export function PersonaVoteCard({ persona, vote, confidence, reasoning, probability, conflictsWith }: PersonaVoteCardProps) {
  const [expanded, setExpanded] = useState(false);
  const p = getPersona(persona);
  const voteColor = VOTE_COLORS[vote ?? 'HOLD'] ?? '#71717a';
  const confPct = confidence ?? 0;
  const hasConflicts = conflictsWith && Object.keys(conflictsWith).length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-surface-2 rounded-lg border border-border overflow-hidden cursor-pointer group"
      style={{ '--hover-color': `${p.color}44` } as React.CSSProperties}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="h-0.5" style={{ background: p.color }} />
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-base" title={p.label}>{p.emoji}</span>
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: p.color }}>{p.code}</span>
          </div>
          {vote && (
            <span className="text-xs font-mono font-bold px-2 py-0.5 rounded" style={{ color: voteColor, backgroundColor: `${voteColor}18` }}>{vote}</span>
          )}
        </div>
        {confidence != null && (
          <div className="mb-2">
            <div className="flex justify-between text-[10px] text-zinc-600 mb-0.5">
              <span>Confidence</span>
              <span className="font-mono">{confPct}%</span>
            </div>
            <div className="h-1 rounded-full bg-surface-0 overflow-hidden">
              <motion.div className="h-full rounded-full" style={{ backgroundColor: p.color }} initial={{ width: 0 }} animate={{ width: `${confPct}%` }} transition={{ duration: 0.5, delay: 0.1 }} />
            </div>
          </div>
        )}
        {probability != null && (
          <div className="flex justify-between text-[10px] text-zinc-600 mb-2">
            <span>Probability</span>
            <span className="font-mono">{probability}%</span>
          </div>
        )}
        {hasConflicts && (
          <div className="flex items-center gap-1 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-[10px] text-amber-500/80">Conflicts: {Object.keys(conflictsWith!).join(', ')}</span>
          </div>
        )}
        <p className={`text-xs text-zinc-400 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>{reasoning}</p>
      </div>
    </motion.div>
  );
}
