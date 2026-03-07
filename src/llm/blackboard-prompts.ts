/**
 * Blackboard-aware prompts for the Swarm debate system.
 *
 * Each persona reads the shared BlackboardState and writes a structured
 * JSON update.  The judge reads the aggregated board and decides whether
 * to continue the debate or produce a final verdict.
 */

import type { SwarmPersona } from './prompts.js';
import type { BlackboardState } from './swarm-blackboard.js';

// ── Persona short codes ────────────────────────────────────────────────

export const BB_PERSONA_CODES: Record<string, string> = {
  risk_manager: 'RM',
  bull_thesis: 'BT',
  bear_thesis: 'BA',
  market_structure: 'MS',
  devils_advocate: 'DA',
  narrative_expert: 'NE',
};

// ── Persona role descriptions ──────────────────────────────────────────

const PERSONA_ROLES: Record<SwarmPersona, string> = {
  risk_manager:
    'RISK MANAGER: find reasons NOT to trade. Focus: liquidation risk, leverage, drawdown, stop-loss adequacy.',
  bull_thesis:
    'BULL ANALYST: argue bullish case. Focus: momentum, breakout, support, catalysts.',
  bear_thesis:
    'BEAR ANALYST: argue bearish case. Focus: resistance, breakdown, macro headwinds, distribution.',
  market_structure:
    'MARKET STRUCTURE: assess regime & microstructure. Focus: order flow, liquidity zones, OI shifts, volume profile.',
  devils_advocate:
    'PROFIT ADVOCATE: find opportunity others miss. Push for action, max leverage, tight entries. You NEVER vote HOLD.',
  narrative_expert:
    'NARRATIVE EXPERT: evaluate news & sentiment narrative. Focus: catalysts, social momentum, macro themes.',
};

// ── Expert prompt ──────────────────────────────────────────────────────

export function buildBlackboardExpertPrompt(
  persona: SwarmPersona,
  boardState: BlackboardState,
): string {
  const code = BB_PERSONA_CODES[persona] ?? persona;
  const role = PERSONA_ROLES[persona];
  const stateJson = JSON.stringify(boardState, null, 2);

  return `ROLE: ${role}
CODE: ${code}

BLACKBOARD STATE:
${stateJson}

Read the blackboard. Analyze the market data provided separately. Write YOUR section update.

OUTPUT (JSON only):
{
  "signals": { "bullish": ["tag1"], "bearish": ["tag2"], "neutral": [] },
  "vote": { "d": "HOLD|LONG|SHORT|CLOSE", "c": <0-100>, "prob": <0-100>, "reason": "<1-2 sentence explanation>" },
  "risks": ["risk_tag"],
  "conflicts_with": { "<CODE>": "<reason_slug>" }
}

RULES:
- signals: short tags, max 5 words per tag.
- vote.reason: 1-2 full sentences explaining your position. NOT a slug.
- risks: short tags.
- conflicts_with: reference persona CODEs you disagree with. Empty {} if no conflict.
- ONLY valid JSON.`;
}

// ── Judge prompt ───────────────────────────────────────────────────────

export function buildBlackboardJudgePrompt(
  round: number,
  boardState: BlackboardState,
  maxRounds: number = 3,
): string {
  const stateJson = JSON.stringify(boardState, null, 2);

  // Build vote summary line
  const voteParts: string[] = [];
  for (const [code, vote] of Object.entries(boardState.votes)) {
    voteParts.push(`${code}: ${vote.d} (conf:${vote.c}, prob:${vote.prob})`);
  }
  const voteSummary = voteParts.length > 0 ? voteParts.join(', ') : 'none';

  const highConflicts = boardState.conflicts.filter(c => c.severity === 'high').length;
  const totalConflicts = boardState.conflicts.length;

  return `SWARM JUDGE. Round ${round}/${maxRounds}.

BLACKBOARD STATE:
${stateJson}

VOTE SUMMARY: ${voteSummary}

CONFLICT COUNT: ${totalConflicts} (high: ${highConflicts})

DECISION RULES:
- 3+ same direction AND no high-severity conflicts -> stop
- High-severity conflict AND round < max -> continue, next_speakers
- DA always pushes for action — weigh his aggression against Risk Manager caution
- If DA and Risk Manager BOTH agree on direction -> high confidence signal
- If final round, MUST produce decision

OUTPUT (JSON only):
{"continue": true|false, "verdict": "<1-sentence summary>", "next_speakers": ["CODE"], "decisions": [{"pair": "<PAIR>", "action": "HOLD|LONG|SHORT|CLOSE", "confidence": <0-100>, "reasoning": "<1-sentence>", "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "size_pct": <number>}], "next_check_minutes": <1-30>}

RULES:
- decisions array: one object per pair from the blackboard market.pairs list.
- For HOLD: leverage, stop_loss_pct, take_profit_pct, size_pct = 0.
- verdict: human-readable sentence, not a slug.`;
}
