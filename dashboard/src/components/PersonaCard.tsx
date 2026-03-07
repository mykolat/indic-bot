interface PersonaCardProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
}

const personaColors: Record<string, string> = {
  risk_manager: 'border-yellow-500',
  bull_thesis: 'border-green-500',
  bear_thesis: 'border-red-500',
  market_structure: 'border-blue-500',
  devils_advocate: 'border-purple-500',
  narrative_expert: 'border-orange-500',
};

export function PersonaCard({ persona, vote, confidence, reasoning }: PersonaCardProps) {
  const border = personaColors[persona] || 'border-zinc-600';
  return (
    <div className={`bg-surface-1 rounded-xl border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-center mb-2">
        <span className="font-semibold text-sm">{persona.replace(/_/g, ' ').toUpperCase()}</span>
        <div className="flex gap-2 text-xs">
          {vote && (
            <span className={vote === 'HOLD' ? 'text-zinc-400' : vote === 'LONG' ? 'text-green-400' : 'text-red-400'}>
              {vote}
            </span>
          )}
          {confidence !== null && <span className="text-zinc-500">conf: {confidence}</span>}
        </div>
      </div>
      <p className="text-zinc-400 text-xs leading-relaxed">{reasoning}</p>
    </div>
  );
}
