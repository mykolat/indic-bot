interface LevelDividerProps {
  level: number;
  label?: string;
}

export function LevelDivider({ level, label }: LevelDividerProps) {
  const labels: Record<number, string> = {
    1: 'Analysis',
    2: 'Critique',
    3: 'Revision',
    4: 'Deep Dive',
    5: 'Final Round',
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-zinc-800" />
      <span className="text-xs text-zinc-500 font-medium shrink-0">
        Level {level}: {label || labels[level] || `Round ${level}`}
      </span>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}
