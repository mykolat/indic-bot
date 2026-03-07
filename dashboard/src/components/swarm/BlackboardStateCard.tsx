import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface BlackboardStateCardProps {
  signals: { bullish: string[]; bearish: string[]; neutral: string[] };
  votes: Record<string, { d: string; c: number; prob: number; reason: string }>;
  risks: string[];
  conflicts: Array<{ between: string[]; topic: string; severity: string }>;
}

const VOTE_DOT_COLORS: Record<string, string> = {
  LONG: 'bg-green-400',
  SHORT: 'bg-red-400',
  HOLD: 'bg-zinc-500',
  CLOSE: 'bg-yellow-400',
};

const VOTE_TEXT_COLORS: Record<string, string> = {
  LONG: 'text-green-400',
  SHORT: 'text-red-400',
  HOLD: 'text-zinc-400',
  CLOSE: 'text-yellow-400',
};

function TagPill({ tag, color }: { tag: string; color: string }) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`inline-block text-xs px-2 py-0.5 rounded-full ${color} mr-1 mb-1`}
    >
      {tag.replace(/_/g, ' ')}
    </motion.span>
  );
}

function ConflictRow({ conflict }: { conflict: { between: string[]; topic: string; severity: string } }) {
  const severityColor =
    conflict.severity === 'high'
      ? 'text-red-400'
      : conflict.severity === 'medium'
        ? 'text-yellow-400'
        : 'text-zinc-400';

  return (
    <div className="flex items-start gap-2 text-xs py-1">
      <span className={`shrink-0 font-semibold uppercase ${severityColor}`}>
        {conflict.severity}
      </span>
      <span className="text-zinc-400">
        {conflict.between.map(p => p.replace(/_/g, ' ')).join(' vs ')}
      </span>
      <span className="text-zinc-500">{conflict.topic}</span>
    </div>
  );
}

export function BlackboardStateCard({ signals, votes, risks, conflicts }: BlackboardStateCardProps) {
  const [open, setOpen] = useState(false);

  const voteEntries = Object.entries(votes);
  const voteCounts: Record<string, number> = {};
  for (const [, v] of voteEntries) {
    voteCounts[v.d] = (voteCounts[v.d] ?? 0) + 1;
  }
  const majority = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0];
  const majorityLabel = majority ? `${majority[1]}/${voteEntries.length} ${majority[0]}` : 'N/A';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden"
    >
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-wider text-zinc-300">
            BLACKBOARD STATE
          </span>

          {/* Vote dots */}
          <div className="flex items-center gap-1">
            {voteEntries.map(([persona, v]) => (
              <div
                key={persona}
                className={`w-2.5 h-2.5 rounded-full ${VOTE_DOT_COLORS[v.d] ?? 'bg-zinc-600'}`}
                title={`${persona.replace(/_/g, ' ')}: ${v.d}`}
              />
            ))}
          </div>

          {/* Majority label */}
          {majority && (
            <span className={`text-xs font-mono font-semibold ${VOTE_TEXT_COLORS[majority[0]] ?? 'text-zinc-400'}`}>
              {majorityLabel}
            </span>
          )}
        </div>

        {/* Chevron */}
        <motion.svg
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="w-4 h-4 text-zinc-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </motion.svg>
      </button>

      {/* Expandable body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 space-y-4 border-t border-zinc-800">
              {/* Signals */}
              {(signals.bullish.length > 0 || signals.bearish.length > 0 || signals.neutral.length > 0) && (
                <div>
                  <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                    Signals
                  </h4>
                  <motion.div
                    initial="hidden"
                    animate="visible"
                    variants={{
                      visible: { transition: { staggerChildren: 0.03 } },
                      hidden: {},
                    }}
                    className="flex flex-wrap"
                  >
                    {signals.bullish.map(tag => (
                      <TagPill key={`bull-${tag}`} tag={tag} color="bg-green-900/50 text-green-300" />
                    ))}
                    {signals.bearish.map(tag => (
                      <TagPill key={`bear-${tag}`} tag={tag} color="bg-red-900/50 text-red-300" />
                    ))}
                    {signals.neutral.map(tag => (
                      <TagPill key={`neut-${tag}`} tag={tag} color="bg-zinc-800 text-zinc-400" />
                    ))}
                  </motion.div>
                </div>
              )}

              {/* Risks */}
              {risks.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                    Risks
                  </h4>
                  <motion.div
                    initial="hidden"
                    animate="visible"
                    variants={{
                      visible: { transition: { staggerChildren: 0.03 } },
                      hidden: {},
                    }}
                    className="flex flex-wrap"
                  >
                    {risks.map(tag => (
                      <TagPill key={`risk-${tag}`} tag={tag} color="bg-yellow-900/50 text-yellow-300" />
                    ))}
                  </motion.div>
                </div>
              )}

              {/* Votes detail */}
              {voteEntries.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                    Votes
                  </h4>
                  <div className="space-y-1.5">
                    {voteEntries.map(([persona, v]) => (
                      <div key={persona} className="flex items-center gap-2 text-xs">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${VOTE_DOT_COLORS[v.d] ?? 'bg-zinc-600'}`} />
                        <span className="text-zinc-400 w-28 truncate" title={persona.replace(/_/g, ' ')}>
                          {persona.replace(/_/g, ' ')}
                        </span>
                        <span className={`font-mono font-semibold w-12 ${VOTE_TEXT_COLORS[v.d] ?? 'text-zinc-400'}`}>
                          {v.d}
                        </span>
                        <span className="text-zinc-500 font-mono">
                          {v.c}% conf
                        </span>
                        <span className="text-zinc-600 font-mono">
                          {v.prob}% prob
                        </span>
                        <span className="text-zinc-600 truncate flex-1" title={v.reason}>
                          {v.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Conflicts */}
              {conflicts.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                    Conflicts
                  </h4>
                  <div>
                    {conflicts.map((c, i) => (
                      <ConflictRow key={i} conflict={c} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
