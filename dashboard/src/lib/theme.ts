export const PERSONA_CONFIG = {
  bull_thesis:      { code: 'BT', label: 'Bull Thesis',      emoji: '\u{1F402}', color: '#4ade80' },
  bear_thesis:      { code: 'BA', label: 'Bear Thesis',      emoji: '\u{1F43B}', color: '#f87171' },
  risk_manager:     { code: 'RM', label: 'Risk Manager',     emoji: '\u{1F6E1}\uFE0F', color: '#eab308' },
  market_structure: { code: 'MS', label: 'Market Structure',  emoji: '\u{1F52C}', color: '#60a5fa' },
  devils_advocate:  { code: 'DA', label: "Profit Advocate",   emoji: '\u{1F4B0}', color: '#22c55e' },
  narrative_expert: { code: 'NE', label: 'Narrative Expert',  emoji: '\u{1F4F0}', color: '#fb923c' },
  judge:            { code: 'JG', label: 'Judge',             emoji: '\u{2696}\uFE0F', color: '#e2e8f0' },
  superuser:        { code: 'SU', label: 'Superuser',         emoji: '\u{1F451}', color: '#f59e0b' },
} as const;

export type PersonaKey = keyof typeof PERSONA_CONFIG;

export const VOTE_COLORS: Record<string, string> = {
  LONG:  '#4ade80',
  SHORT: '#f87171',
  HOLD:  '#71717a',
  CLOSE: '#eab308',
};

/** Fixed display order for persona dots (RM first as gatekeeper, then structure, then thesis, then special) */
export const PERSONA_ORDER: PersonaKey[] = [
  'risk_manager',
  'market_structure',
  'bull_thesis',
  'bear_thesis',
  'narrative_expert',
  'devils_advocate',
];

export function sortPersonas<T extends { persona: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ai = PERSONA_ORDER.indexOf(a.persona);
    const bi = PERSONA_ORDER.indexOf(b.persona);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

export function getPersona(name: string) {
  return PERSONA_CONFIG[name as PersonaKey] ?? { code: name.slice(0, 2).toUpperCase(), label: name.replace(/_/g, ' '), emoji: '\u{1F916}', color: '#a1a1aa' };
}
