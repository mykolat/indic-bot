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

RESPONSE FORMAT — respond with ONLY this JSON object, nothing else.
No explanations, no markdown, no code blocks. Just raw JSON:

{"signals":{"bullish":["tag1"],"bearish":["tag2"],"neutral":[]},"vote":{"d":"HOLD|LONG|SHORT|CLOSE","c":65,"prob":55,"reason":"1-2 sentence explanation"},"risks":["risk_tag"],"conflicts_with":{"CODE":"reason_slug"}}

FIELD GUIDE:
- signals: short tags, max 5 words per tag
- vote.d: your directional call
- vote.c: confidence 0-100
- vote.prob: probability of success 0-100
- vote.reason: 1-2 full sentences explaining your position. NOT a slug.
- risks: short tags
- conflicts_with: persona CODEs you disagree with. Empty {} if no conflict`;
}

// ── DA (Profit Advocate) prompt ───────────────────────────────────────

export function buildDAPrompt(boardState: BlackboardState): string {
  const stateJson = JSON.stringify(boardState, null, 2);

  // Build vote summary for DA to see
  const voteSummary = Object.entries(boardState.votes)
    .map(([code, v]) => `${code}: ${v.d} (conf:${v.c}, prob:${v.prob}) — ${v.reason}`)
    .join('\n');

  const hasClose = Object.values(boardState.votes).some(v => v.d === 'CLOSE');
  const closeInstruction = hasClose
    ? `\nSomeone voted CLOSE. Argue AGAINST closing. The position still has potential. Find reasons to hold or even add.`
    : '';

  return `ROLE: PROFIT ADVOCATE (DA) — You are an aggressive trader who ALWAYS finds reasons to trade.
CODE: DA

You see opportunity where others see risk. You NEVER vote HOLD.
Search the web and X/Twitter for real-time data, then distill your findings into the JSON template below.

OTHER EXPERTS VOTED:
${voteSummary}
${closeInstruction}

YOUR JOB:
- Find catalysts, momentum signals, whale activity, funding rate shifts that support trading
- Push for higher leverage and larger position size than others suggest
- Acknowledge risks briefly but immediately counter them with opportunity
- Be specific: cite prices, percentages, timeframes from your search results

PAIRS: ${boardState.market.pairs.join(', ')}

BLACKBOARD STATE:
${stateJson}

RESPONSE FORMAT — you MUST respond with ONLY this JSON object, nothing else.
Do NOT write explanations, commentary, or markdown before or after the JSON.
Do NOT wrap in code blocks. Just raw JSON:

{"signals":{"bullish":["tag1"],"bearish":[],"neutral":[]},"vote":{"d":"LONG or SHORT","c":65,"prob":55,"reason":"1-2 sentences with specific data from search"},"risks":["risk_tag"],"conflicts_with":{"CODE":"reason_slug"}}

FIELD GUIDE:
- vote.d: LONG or SHORT only. Never HOLD, never CLOSE.
- vote.c: your confidence 0-100
- vote.prob: probability of success 0-100
- vote.reason: must cite specific data you found (prices, %, whale moves, funding)
- signals: key bullish/bearish/neutral tags from your research
- risks: brief risk tags
- conflicts_with: you ALWAYS conflict with anyone who voted HOLD or CLOSE`;
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
- DA is a reactive aggressive trader — his arguments are search-backed but biased toward action
- DA has normal vote weight. Judge may add +0.1 confidence bonus if DA cites strong evidence
- If DA and RM both agree on direction -> strong conviction signal
- DA arguments against CLOSE should be weighed against RM caution — not auto-accepted
- If final round, MUST produce decision

OUTPUT (JSON only):
{"continue": true|false, "verdict": "<1-sentence summary>", "next_speakers": ["CODE"], "decisions": [{"pair": "<PAIR>", "action": "HOLD|LONG|SHORT|CLOSE", "confidence": <0-100>, "reasoning": "<1-sentence>", "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "size_pct": <number>}], "next_check_minutes": <1-30>}

RULES:
- decisions array: one object per pair from the blackboard market.pairs list.
- For HOLD: leverage, stop_loss_pct, take_profit_pct, size_pct = 0.
- verdict: human-readable sentence, not a slug.`;
}
