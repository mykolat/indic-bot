import { getPersona, VOTE_COLORS } from '../../lib/theme';

interface VoteItem {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  conflictsWith?: Record<string, string> | null;
}

interface VoteRowProps {
  votes: VoteItem[];
}

export function VoteRow({ votes }: VoteRowProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {votes.map((v) => {
        const p = getPersona(v.persona);
        const color = VOTE_COLORS[v.vote ?? 'HOLD'] ?? '#71717a';
        const hasConflict = v.conflictsWith && Object.keys(v.conflictsWith).length > 0;

        return (
          <div
            key={v.persona}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-border-subtle group relative"
          >
            <span className="text-sm" title={p.label}>{p.emoji}</span>
            <span className="text-[11px] font-semibold text-zinc-400">{p.label}</span>
            <span
              className="text-[10px] font-mono font-bold px-1.5 py-px rounded"
              style={{ color, backgroundColor: `${color}15` }}
            >
              {v.vote ?? 'N/A'}
            </span>
            {v.confidence != null && (
              <span className="text-[10px] text-zinc-600 font-mono">{v.confidence}%</span>
            )}
            {hasConflict && (
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" title={`Conflicts: ${Object.keys(v.conflictsWith!).join(', ')}`} />
            )}

            {/* Tooltip with reasoning on hover */}
            <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-10 max-w-xs">
              <div className="bg-surface-3 border border-border rounded-lg px-3 py-2 text-[11px] text-zinc-400 shadow-lg">
                {v.reasoning.replace(/_/g, ' ')}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
