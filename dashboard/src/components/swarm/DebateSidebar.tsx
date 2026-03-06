interface DebateItem {
  cycleId: number;
  createdAt: string;
  votes: Array<{ persona: string; vote: string | null }>;
  summary: string;
}

interface DebateSidebarProps {
  debates: DebateItem[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}

const VOTE_DOT_COLORS: Record<string, string> = {
  LONG: '#4ade80',
  SHORT: '#f87171',
  HOLD: '#71717a',
};

export function DebateSidebar({ debates, selectedIdx, onSelect }: DebateSidebarProps) {
  return (
    <div className="w-72 shrink-0 border-r border-zinc-800 overflow-y-auto">
      <div className="p-3 border-b border-zinc-800">
        <h2 className="text-sm font-bold text-zinc-300">Debates</h2>
      </div>
      {debates.map((d, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className={`w-full text-left p-3 border-b border-zinc-800/50 transition-colors ${
            selectedIdx === i ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
          }`}
        >
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs font-mono text-zinc-400">Cycle {d.cycleId}</span>
            <span className="text-xs text-zinc-600">
              {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="flex gap-1 mb-1">
            {d.votes.map((v, j) => (
              <div
                key={j}
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: VOTE_DOT_COLORS[v.vote ?? 'HOLD'] ?? '#71717a' }}
                title={`${v.persona}: ${v.vote ?? 'N/A'}`}
              />
            ))}
          </div>
          <p className="text-xs text-zinc-500 truncate">{d.summary}</p>
        </button>
      ))}
      {debates.length === 0 && (
        <div className="p-4 text-zinc-600 text-xs">No debates found</div>
      )}
    </div>
  );
}
