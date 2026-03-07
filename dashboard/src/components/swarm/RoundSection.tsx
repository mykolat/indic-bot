import { BlackboardView } from './BlackboardView';

interface RoundPersona {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
  time?: string;
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
}

interface RoundSectionProps {
  round: number;
  personas: RoundPersona[];
  judgeRawResponse?: string;
  isFinalRound: boolean;
  blackboardSignals?: { bullish: string[]; bearish: string[]; neutral: string[] };
  blackboardRisks?: string[];
}

export function RoundSection({ round, personas, judgeRawResponse, isFinalRound, blackboardRisks }: RoundSectionProps) {
  return (
    <BlackboardView
      round={round}
      personas={personas}
      judgeRawResponse={judgeRawResponse}
      isFinalRound={isFinalRound}
      risks={blackboardRisks ?? []}
    />
  );
}
