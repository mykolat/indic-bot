import { getPersona } from '../../lib/theme';

interface PerPersonaSignals {
  persona: string;
  signals: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
}

interface SignalBoardProps {
  personaSignals: PerPersonaSignals[];
  risks: string[];
}

interface AttributedSignal {
  text: string;
  personas: string[];
}

function aggregateSignals(personaSignals: PerPersonaSignals[], type: 'bullish' | 'bearish' | 'neutral'): AttributedSignal[] {
  const map = new Map<string, string[]>();
  for (const ps of personaSignals) {
    for (const sig of ps.signals[type] ?? []) {
      const normalized = sig.toLowerCase().replace(/_/g, ' ');
      const existing = map.get(normalized) ?? [];
      existing.push(ps.persona);
      map.set(normalized, existing);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([text, personas]) => ({ text, personas }));
}

function SignalTag({ signal, color, bgColor }: { signal: AttributedSignal; color: string; bgColor: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ color, backgroundColor: bgColor }}>
      {signal.text}
      {signal.personas.map(p => (
        <span key={p} className="text-[9px] opacity-70" title={getPersona(p).label}>
          {getPersona(p).emoji}
        </span>
      ))}
    </span>
  );
}

export function SignalBoard({ personaSignals, risks }: SignalBoardProps) {
  const bullish = aggregateSignals(personaSignals, 'bullish');
  const bearish = aggregateSignals(personaSignals, 'bearish');

  if (bullish.length === 0 && bearish.length === 0 && risks.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-border">
        <div className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-green-500/60 mb-2">
            Bullish ({bullish.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bullish.map(s => (
              <SignalTag key={s.text} signal={s} color="#4ade80" bgColor="rgba(74,222,128,0.1)" />
            ))}
          </div>
        </div>
        <div className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-red-500/60 mb-2">
            Bearish ({bearish.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bearish.map(s => (
              <SignalTag key={s.text} signal={s} color="#f87171" bgColor="rgba(248,113,113,0.1)" />
            ))}
          </div>
        </div>
      </div>
      {risks.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-yellow-500/60">Risks</span>
            {risks.map(r => (
              <span key={r} className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-900/20 text-yellow-500/80 font-mono">
                {r.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
