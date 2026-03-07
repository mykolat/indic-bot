import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getPersona, VOTE_COLORS } from '../../lib/theme';

interface PersonaVoteCardProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
  time?: string;
}

export function PersonaVoteCard({ persona, vote, confidence, reasoning, time, conflictsWith }: PersonaVoteCardProps) {
  const [expanded, setExpanded] = useState(false);
  const p = getPersona(persona);
  const voteColor = VOTE_COLORS[vote ?? 'HOLD'] ?? '#71717a';
  const hasConflicts = conflictsWith && Object.keys(conflictsWith).length > 0;
  const isJudge = persona === 'judge';
  const isSuperuser = persona === 'superuser';

  return (
    <motion.div
      initial={{ opacity: 0, x: isJudge ? 20 : -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex gap-3 ${isJudge ? 'flex-row-reverse' : ''}`}
    >
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
        style={{ backgroundColor: `${p.color}15`, border: `1.5px solid ${p.color}40` }}
        title={p.label}
      >
        {p.emoji}
      </div>

      {/* Bubble */}
      <div className={`max-w-[80%] flex flex-col ${isJudge ? 'items-end' : 'items-start'}`}>
        {/* Header line */}
        <div className={`flex items-center gap-2 mb-1 ${isJudge ? 'flex-row-reverse' : ''}`}>
          <span className="text-[11px] font-semibold" style={{ color: p.color }}>
            {p.label}
          </span>
          {vote && (
            <span
              className="text-[10px] font-mono font-bold px-1.5 py-px rounded"
              style={{ color: voteColor, backgroundColor: `${voteColor}15` }}
            >
              {vote}
            </span>
          )}
          {confidence != null && (
            <span className="text-[10px] text-zinc-600 font-mono">
              {confidence}%
            </span>
          )}
          {time && <span className="text-[10px] text-zinc-700">{time}</span>}
        </div>

        {/* Conflict indicator */}
        {hasConflicts && (
          <div className="flex items-center gap-1 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-[10px] text-amber-500/70">
              vs {Object.keys(conflictsWith!).join(', ')}
            </span>
          </div>
        )}

        {/* Message bubble */}
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed cursor-pointer transition-colors ${
            isJudge
              ? 'bg-surface-3 text-zinc-200 rounded-tr-sm'
              : isSuperuser
                ? 'bg-amber-950/30 border border-amber-800/30 text-zinc-300 rounded-tl-sm'
                : 'bg-surface-2 text-zinc-400 rounded-tl-sm hover:bg-surface-3/80'
          }`}
          onClick={() => setExpanded(e => !e)}
        >
          <AnimatePresence mode="wait">
            {expanded ? (
              <motion.p
                key="full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="whitespace-pre-wrap"
              >
                {reasoning}
              </motion.p>
            ) : (
              <motion.p
                key="short"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="line-clamp-2"
              >
                {reasoning}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Expand hint */}
          {reasoning.length > 120 && (
            <span className="text-[10px] text-zinc-600 mt-1 block">
              {expanded ? 'click to collapse' : '...click to expand'}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
