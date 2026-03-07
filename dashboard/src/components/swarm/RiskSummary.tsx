import { useState } from 'react';

interface RiskSummaryProps {
  risks: string[];
}

export function RiskSummary({ risks }: RiskSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  if (risks.length === 0) return null;

  const top3 = risks.slice(0, 3).map(r => r.replace(/_/g, ' '));
  const rest = risks.length - 3;

  return (
    <div className="text-sm text-center" style={{ color: 'var(--text-muted)' }}>
      {expanded
        ? risks.map(r => r.replace(/_/g, ' ')).join(', ')
        : top3.join(', ')}
      {rest > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="ml-1.5 inline-flex items-center justify-center rounded-full text-xs font-mono px-1.5 py-0.5"
          style={{
            backgroundColor: 'var(--surface-3)',
            color: 'var(--text-faint)',
          }}
        >
          +{rest}
        </button>
      )}
      {expanded && rest > 0 && (
        <button
          onClick={() => setExpanded(false)}
          className="ml-1.5 text-xs"
          style={{ color: 'var(--text-faint)' }}
        >
          collapse
        </button>
      )}
    </div>
  );
}
