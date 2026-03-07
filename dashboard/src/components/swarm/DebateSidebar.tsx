import { VOTE_COLORS, getPersona } from '../../lib/theme';

interface DebateItem {
  cycleId: number;
  createdAt: string;
  votes: Array<{ persona: string; vote: string | null }>;
  summary: string;
  isSkip?: boolean;
  skipReason?: string;
}

interface DebateSidebarProps {
  debates: DebateItem[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}

export function DebateSidebar({ debates, selectedIdx, onSelect }: DebateSidebarProps) {
  return (
    <div className="w-64 shrink-0 border-r border-border overflow-y-auto bg-surface-1">
      <div className="p-4 border-b border-border">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Debates</h2>
      </div>
      {debates.map((d, i) => {
        const isSelected = selectedIdx === i;

        if (d.isSkip) {
          return (
            <div
              key={i}
              className="w-full text-left px-4 py-3 border-b border-border-subtle border-l-2 border-l-yellow-600/40 bg-yellow-950/10"
            >
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-mono text-yellow-600/70">#{d.cycleId}</span>
                <span className="text-[10px] text-zinc-600 font-mono">
                  {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="text-[10px] text-yellow-600/60 font-mono">SKIPPED</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">{d.skipReason}</p>
            </div>
          );
        }

        return (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={`w-full text-left px-4 py-3 border-b border-border-subtle transition-all ${
              isSelected
                ? 'bg-surface-2 border-l-2 border-l-accent'
                : 'hover:bg-surface-2/50 border-l-2 border-l-transparent'
            }`}
          >
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-xs font-mono text-zinc-400">#{d.cycleId}</span>
              <span className="text-[10px] text-zinc-600 font-mono">
                {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="flex gap-1 mb-1.5">
              {d.votes.map((v, j) => (
                <div
                  key={j}
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: VOTE_COLORS[v.vote ?? 'HOLD'] ?? '#71717a' }}
                  title={`${getPersona(v.persona).label}: ${v.vote ?? 'N/A'}`}
                />
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 truncate">{d.summary}</p>
          </button>
        );
      })}
      {debates.length === 0 && (
        <div className="space-y-0 animate-pulse">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="px-4 py-3 border-b border-border-subtle">
              <div className="flex justify-between mb-1.5">
                <div className="h-3 bg-surface-3 rounded w-12" />
                <div className="h-3 bg-surface-2 rounded w-10" />
              </div>
              <div className="flex gap-1 mb-1.5">
                {Array.from({ length: 5 }).map((_, j) => (
                  <div key={j} className="w-2 h-2 rounded-full bg-surface-3" />
                ))}
              </div>
              <div className="h-2.5 bg-surface-2 rounded w-3/4" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
