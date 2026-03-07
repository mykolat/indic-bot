interface FunnelStep {
  label: string;
  count: number;
  color: string;
}

export function FunnelBar({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-xs text-zinc-400 w-32 text-right shrink-0">{step.label}</span>
          <div className="flex-1 h-6 bg-surface-2 rounded overflow-hidden">
            <div
              className="h-full rounded transition-all"
              style={{ width: `${(step.count / max) * 100}%`, backgroundColor: step.color }}
            />
          </div>
          <span className="text-sm font-mono text-zinc-300 w-12">{step.count}</span>
          {i > 0 && (
            <span className="text-xs text-zinc-500 w-12">
              {steps[i - 1].count > 0
                ? `${Math.round((step.count / steps[i - 1].count) * 100)}%`
                : '—'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
