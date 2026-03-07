import { useState } from 'react';

interface SemiGaugeProps {
  bullCount: number;
  bearCount: number;
  bullSignals: string[];
  bearSignals: string[];
}

export function SemiGauge({ bullCount, bearCount, bullSignals, bearSignals }: SemiGaugeProps) {
  const [hover, setHover] = useState<'bull' | 'bear' | null>(null);
  const total = bullCount + bearCount || 1;
  const ratio = bullCount / total; // 0 = full bear, 1 = full bull
  const angle = 180 - ratio * 180; // 0° = full bull (left), 180° = full bear (right)

  const needleX = 100 + 70 * Math.cos((angle * Math.PI) / 180);
  const needleY = 100 - 70 * Math.sin((angle * Math.PI) / 180);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: 200, height: 110 }}>
        <svg viewBox="0 0 200 110" width={200} height={110}>
          {/* Bull arc (left) */}
          <path
            d="M 10 100 A 90 90 0 0 1 100 10"
            fill="none"
            stroke="var(--accent-bull)"
            strokeWidth={8}
            strokeLinecap="round"
            opacity={hover === 'bear' ? 0.3 : 0.7}
            onMouseEnter={() => setHover('bull')}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'pointer' }}
          />
          {/* Bear arc (right) */}
          <path
            d="M 100 10 A 90 90 0 0 1 190 100"
            fill="none"
            stroke="var(--accent-bear)"
            strokeWidth={8}
            strokeLinecap="round"
            opacity={hover === 'bull' ? 0.3 : 0.7}
            onMouseEnter={() => setHover('bear')}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'pointer' }}
          />
          {/* Needle */}
          <line
            x1={100} y1={100}
            x2={needleX} y2={needleY}
            stroke="var(--text)"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={100} cy={100} r={4} fill="var(--text)" />
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="absolute top-0 z-10 rounded-lg border px-3 py-2 text-sm max-w-[200px]"
            style={{
              left: hover === 'bull' ? 0 : 'auto',
              right: hover === 'bear' ? 0 : 'auto',
              backgroundColor: 'var(--surface-1)',
              borderColor: 'var(--border)',
              color: 'var(--text-muted)',
            }}
          >
            {(hover === 'bull' ? bullSignals : bearSignals).map((s, i) => (
              <div key={i} className="text-xs">{s}</div>
            ))}
          </div>
        )}
      </div>

      <div className="text-sm" style={{ color: 'var(--text-faint)' }}>
        <span style={{ color: 'var(--accent-bull)' }}>{bullCount}</span>
        {' bullish \u00B7 '}
        <span style={{ color: 'var(--accent-bear)' }}>{bearCount}</span>
        {' bearish'}
      </div>
    </div>
  );
}
