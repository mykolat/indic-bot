import { useState } from 'react';
import { getPersona } from '../../lib/theme.js';

interface PersonaDotProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
}

interface PersonaDotsProps {
  votes: PersonaDotProps[];
}

const DOT_COLORS: Record<string, string> = {
  LONG: 'var(--accent-bull)',
  SHORT: 'var(--accent-bear)',
  HOLD: 'var(--text-faint)',
  CLOSE: 'var(--accent-warn)',
};

export function PersonaDots({ votes }: PersonaDotsProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <div className="flex items-center gap-3 justify-center relative">
      {votes.map((v, i) => {
        const p = getPersona(v.persona);
        const color = DOT_COLORS[v.vote ?? 'HOLD'] ?? 'var(--text-faint)';
        return (
          <div
            key={v.persona}
            className="relative"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <div
              className="w-2.5 h-2.5 rounded-full cursor-pointer transition-transform"
              style={{
                backgroundColor: color,
                transform: hovered === i ? 'scale(1.5)' : 'scale(1)',
              }}
            />
            {hovered === i && (
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs z-10"
                style={{
                  backgroundColor: 'var(--surface-1)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-muted)',
                }}
              >
                {p.label} · {v.vote ?? 'N/A'} · {v.confidence ?? '?'}%
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
