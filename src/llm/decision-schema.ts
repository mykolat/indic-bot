export interface DecisionV2 {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
  confidence: number;

  setup_detected: boolean;
  setup_type: string;
  directional_bias: 'long' | 'short' | 'neutral';
  entry_valid_now: boolean;
  invalidators: string[];

  risk_flags: string[];
  data_gaps: string[];
  abstain_reason: string | null;

  session_context?: {
    session_pattern_active: boolean;
    session_fit_score: number;
    session_role: 'supports' | 'neutral' | 'contradicts';
    session_reason: string;
  };
  capitulation_assessment?: {
    mode: 'continuation' | 'exhaustion' | 'unclear';
    reason: string;
  };
}

export const SCHEMA_VERSION = 2;

export interface LLMResponse {
  decisions: DecisionV2[];
  next_check_minutes: number;
}

export function parseDecisions(raw: string): { decisions: DecisionV2[]; nextCheckMinutes: number } | null {
  try {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
      if (!match) return null;
      parsed = JSON.parse(match[0]);
    }

    if (!Array.isArray(parsed.decisions)) return null;

    const decisions: DecisionV2[] = parsed.decisions.map((d: any) => ({
      pair: d.pair,
      action: d.action,
      size_pct: d.size_pct ?? 0,
      leverage: d.leverage ?? 0,
      stop_loss_pct: d.stop_loss_pct ?? 0,
      take_profit_pct: d.take_profit_pct ?? 0,
      reasoning: d.reasoning ?? '',
      confidence: d.confidence ?? 50,
      setup_detected: d.setup_detected ?? false,
      setup_type: d.setup_type ?? 'none',
      directional_bias: d.directional_bias ?? 'neutral',
      entry_valid_now: d.entry_valid_now ?? false,
      invalidators: Array.isArray(d.invalidators) ? d.invalidators : [],
      risk_flags: Array.isArray(d.risk_flags) ? d.risk_flags : [],
      data_gaps: Array.isArray(d.data_gaps) ? d.data_gaps : [],
      abstain_reason: d.abstain_reason ?? null,
      session_context: d.session_context,
      capitulation_assessment: d.capitulation_assessment,
    }));

    const ncm = parsed.next_check_minutes;
    const nextCheckMinutes = typeof ncm === 'number'
      ? Math.max(10, Math.min(30, ncm))
      : 15;

    return { decisions, nextCheckMinutes };
  } catch {
    return null;
  }
}
