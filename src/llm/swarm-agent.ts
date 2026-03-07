import type { LLMClient } from './client.js';
import type { TradeDecision } from '../risk/manager.js';
import { buildUserPrompt, type EnrichedPromptData, type SwarmPersona } from './prompts.js';
import { insertSwarmPersona, insertLlmConversation } from '../db/repository.js';
import { buildSwarmFingerprint, hasChanged } from './swarm-fingerprint.js';
import { SwarmBlackboard, type PersonaUpdate } from './swarm-blackboard.js';
import { buildBlackboardExpertPrompt, buildBlackboardJudgePrompt, BB_PERSONA_CODES } from './blackboard-prompts.js';

// ── Legacy interfaces (kept for backward compatibility) ───────────────

export interface ExpertOutput {
  persona: string;
  pair: string;
  position: string;
  thesis: string;
  arguments: string[];
  probability_of_success: number;
  key_risks: string[];
  confidence: number;
}

export interface CritiqueOutput {
  persona: string;
  critiques: Array<{
    target_persona: string;
    agrees: boolean;
    critique: string;
    counter_argument?: string;
  }>;
  updated_probability: number;
  updated_position: string;
  strongest_risk_found: string;
}

export interface ReviseOutput {
  persona: string;
  original_position: string;
  revised_position: string;
  changed_mind: boolean;
  revised_thesis: string;
  revised_arguments: string[];
  revised_probability: number;
  key_concessions: string[];
  final_confidence: number;
}

export function parseExpertOutput(raw: string, persona: string): ExpertOutput | null {
  try {
    const parsed = JSON.parse(raw);
    // LLM may return an array of objects (one per pair)
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (obj && obj.thesis && typeof obj.probability_of_success === 'number') {
      return { ...obj, persona };
    }
  } catch {
    // Try to extract first JSON object with "thesis"
    const match = raw.match(/\{[^{}]*"thesis"[^{}]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.thesis) return { ...parsed, persona };
      } catch { /* ignore */ }
    }
    // Try full array
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        const arr = JSON.parse(arrMatch[0]);
        if (Array.isArray(arr) && arr[0]?.thesis) return { ...arr[0], persona };
      } catch { /* ignore */ }
    }
  }
  console.warn(`[Swarm] Failed to parse ${persona} structured output, using raw text`);
  return null;
}

// ── Legacy judge prompt (kept for backward compat) ────────────────────

export function buildJudgePrompt(expertOutputs: (ExpertOutput | null)[], rawTexts: string[], personas: SwarmPersona[], critiqueOutputs?: (CritiqueOutput | null)[], reviseOutputs?: (ReviseOutput | null)[]): string {
  const sections: string[] = [];
  for (let i = 0; i < expertOutputs.length; i++) {
    const eo = expertOutputs[i];
    const rev = reviseOutputs?.[i];
    const crit = critiqueOutputs?.[i];

    if (rev) {
      sections.push(`## ${personas[i].toUpperCase()} (REVISED)
Original position: ${rev.original_position} → Revised: ${rev.revised_position} ${rev.changed_mind ? '(CHANGED MIND)' : '(HELD)'}
Thesis: ${rev.revised_thesis}
Arguments: ${rev.revised_arguments.join('; ')}
probability_of_success: ${rev.revised_probability}%
Concessions: ${rev.key_concessions.join('; ')}
Confidence: ${rev.final_confidence}/100`);
    } else if (eo) {
      let section = `## ${eo.persona.toUpperCase()}
Position: ${eo.position}
Thesis: ${eo.thesis}
Arguments: ${eo.arguments.join('; ')}
probability_of_success: ${eo.probability_of_success}%
Key risks: ${eo.key_risks.join('; ')}
Confidence: ${eo.confidence}/100`;
      if (crit) {
        section += `\nAfter critique — updated position: ${crit.updated_position}, probability: ${crit.updated_probability}%`;
        section += `\nStrongest risk found: ${crit.strongest_risk_found}`;
      }
      sections.push(section);
    } else {
      sections.push(`## ${personas[i].toUpperCase()} (parse failed)\n${rawTexts[i]?.slice(0, 500) ?? 'no output'}`);
    }
  }

  const debateStage = reviseOutputs ? '3-stage debate (generate → critique → revise)' : critiqueOutputs ? '2-stage debate (generate → critique)' : 'single-stage';

  return `You are the SWARM CONSENSUS JUDGE managing a LIVE crypto futures account with real money.

Below are structured opinions from expert analysts after ${debateStage}. Weigh their arguments by probability_of_success and confidence scores.
Higher probability + higher confidence = more weight.
The Profit Advocate (DA) always pushes for action — his arguments are search-backed. Weigh DA aggression against Risk Manager caution.
Experts who changed their mind after critique show intellectual honesty — weight their revised view higher.

${sections.join('\n\n')}

Based on these expert opinions, produce the final consensus trading decision.
If experts strongly disagree, lean towards HOLD.
If the Risk Manager flags critical danger, lean towards CLOSE or HOLD regardless of DA.

You MUST respond with valid JSON:
{"decisions": [{"pair": "<pair>", "action": "LONG|SHORT|HOLD|CLOSE", "size_pct": <number>, "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "confidence": <0-100>, "reasoning": "<string>"}], "next_check_minutes": <1-30>}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Reverse lookup: persona code → SwarmPersona name */
const CODE_TO_PERSONA: Record<string, SwarmPersona> = {};
for (const [name, code] of Object.entries(BB_PERSONA_CODES)) {
  CODE_TO_PERSONA[code] = name as SwarmPersona;
}

function parsePersonaUpdate(raw: string): PersonaUpdate | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.vote) return parsed;
  } catch {
    const match = raw.match(/\{[\s\S]*"vote"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed?.vote) return parsed;
      } catch { /* */ }
    }
  }
  return null;
}

// ── SwarmAgent (Blackboard Pattern) ───────────────────────────────────

export class SwarmAgent {
  sessionId: string | undefined;
  cycleId: number | undefined;
  private lastFingerprint: string = '';
  private lastDecisions: TradeDecision[] = [];
  private lastDebateAt: number = 0;
  private static readonly DEBATE_TTL_MS = 30 * 60_000; // 30 minutes

  constructor(private llm: LLMClient, private grokLlm?: any, private sourceHealth?: any) { }

  async getConsensus(data: EnrichedPromptData): Promise<TradeDecision[]> {
    // Fingerprint-based dedup: skip debate if market state unchanged
    const fp = buildSwarmFingerprint({
      positions: data.portfolio.positions.map(p => ({
        pair: p.pair,
        side: p.side,
        unrealizedPnlPct: p.unrealizedPnlPct,
      })),
      regime: data.regime ?? '',
      volumeRatio: data.snapshots[0]?.volumeRatio ?? 0,
      fearGreedValue: data.fearGreed?.value ?? 50,
    });

    const cacheExpired = Date.now() - this.lastDebateAt > SwarmAgent.DEBATE_TTL_MS;

    if (!hasChanged(this.lastFingerprint, fp) && this.lastDecisions.length > 0 && !cacheExpired) {
      console.log('[Swarm] Fingerprint unchanged — reusing previous consensus');
      return this.lastDecisions;
    }

    const userPrompt = buildUserPrompt(data);
    const MAX_ROUNDS = 4;
    const allPersonas: SwarmPersona[] = ['risk_manager', 'market_structure', 'devils_advocate'];
    if (this.grokLlm) allPersonas.push('narrative_expert');

    // Initialize blackboard with market context
    const bb = new SwarmBlackboard({
      pairs: data.snapshots.map(s => s.pair),
      regime: data.regime ?? '',
      fearGreed: data.fearGreed?.value ?? 50,
      volumeRatio: data.snapshots[0]?.volumeRatio ?? 0,
    });

    // Keep conversation history for DB backward compatibility
    const conversationHistory: Array<{ persona: string; content: string; vote?: string; phase: number }> = [];

    let finalDecisions: TradeDecision[] = [];
    let nextSpeakers: SwarmPersona[] = allPersonas;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const speakers = round === 1 ? allPersonas : nextSpeakers;
      console.log(`[Swarm] Round ${round}: ${speakers.join(', ')}`);

      // Each persona reads the blackboard and writes a structured update
      const expertCalls = speakers.map(p => {
        const systemPrompt = buildBlackboardExpertPrompt(p, bb.getState());
        const isGrok = p === 'narrative_expert' && this.grokLlm;
        return isGrok
          ? this.grokLlm.call(systemPrompt, userPrompt, 'grok-4-1-fast-non-reasoning', { search: true })
          : this.llm.call(systemPrompt, userPrompt);
      });

      const results = await Promise.allSettled(expertCalls);
      const levelPending: Array<{ persona: string; model: string; raw_response: string; vote?: string; confidence?: number; reasoning?: string; phase: number; conflicts_with?: Record<string, string>; signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] } }> = [];

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 'fulfilled') {
          const raw = res.value;
          const update = parsePersonaUpdate(raw);
          if (speakers[i] === 'narrative_expert') this.sourceHealth?.recordSuccess('grok-narrative');

          if (update?.vote) {
            const code = BB_PERSONA_CODES[speakers[i]] ?? speakers[i].slice(0, 2).toUpperCase();
            bb.mergePersonaUpdate(code, update);

            conversationHistory.push({
              persona: speakers[i],
              content: raw.slice(0, 500),
              vote: update.vote.d,
              phase: round,
            });

            if (this.sessionId) {
              levelPending.push({
                persona: speakers[i],
                model: speakers[i] === 'narrative_expert' ? 'grok' : 'codex',
                raw_response: raw,
                vote: update.vote.d,
                confidence: update.vote.c,
                reasoning: update.vote.reason || raw.slice(0, 500),
                phase: round,
                conflicts_with: update.conflicts_with,
                signals: update.signals,
              });
            }
          } else {
            // Parse failed but response came back
            console.warn(`[Swarm] ${speakers[i]} returned unparseable update at round ${round}`);
            conversationHistory.push({
              persona: speakers[i],
              content: raw.slice(0, 500),
              phase: round,
            });
            if (this.sessionId) {
              levelPending.push({
                persona: speakers[i],
                model: speakers[i] === 'narrative_expert' ? 'grok' : 'codex',
                raw_response: raw,
                reasoning: raw.slice(0, 500),
                phase: round,
              });
            }
          }
        } else {
          console.warn(`[Swarm] ${speakers[i]} failed at round ${round}:`, results[i].status === 'rejected' ? (results[i] as PromiseRejectedResult).reason : '');
          if (speakers[i] === 'narrative_expert') {
            const reason = results[i].status === 'rejected' ? (results[i] as PromiseRejectedResult).reason : new Error('unknown');
            this.sourceHealth?.recordFailure('grok-narrative', reason?.message ?? String(reason));
          }
        }
      }

      if (conversationHistory.filter(m => m.phase === round).length === 0) {
        console.error('[Swarm] All sub-agents failed at round', round);
        throw new Error('Swarm failure');
      }

      // Judge reads the blackboard
      const judgePrompt = buildBlackboardJudgePrompt(round, bb.getState(), MAX_ROUNDS);
      let rawJudge: string;
      try {
        rawJudge = await this.llm.call(judgePrompt, userPrompt);
      } catch (e) {
        console.error(`[Swarm] Judge failed at round ${round}:`, e);
        return [];
      }

      conversationHistory.push({ persona: 'judge', content: rawJudge.slice(0, 500), phase: round });

      // Parse judge response
      let judgeResult: any;
      try {
        judgeResult = JSON.parse(rawJudge);
      } catch {
        const match = rawJudge.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
        if (match) { try { judgeResult = JSON.parse(match[0]); } catch { /* ignore */ } }
      }

      if (!judgeResult) {
        console.error(`[Swarm] Judge parse failed at round ${round}`);
        return [];
      }

      console.log(`[Swarm] Round ${round} Judge: continue=${judgeResult.continue}, verdict="${(judgeResult.verdict || '').slice(0, 80)}"`);

      const ncm = judgeResult.next_check_minutes;
      if (typeof ncm === 'number' && Number.isFinite(ncm) && ncm >= 1 && ncm <= 30) {
        this.llm.lastNextCheckMinutes = ncm;
      }

      // Store DB for this round
      if (this.sessionId) {
        if (!this.cycleId) {
          console.warn('[Swarm] WARNING: cycleId is null — conversation will not be linked to cycle');
        }
        insertLlmConversation({
          cycle_id: this.cycleId,
          session_id: this.sessionId,
          layer: 1,
          model: 'codex',
          method: 'swarm_consensus',
          label: `judge_round_${round}`,
          system_prompt: judgePrompt,
          user_prompt: userPrompt,
          raw_response: rawJudge,
          blackboard_state: JSON.parse(bb.toJSON()),
        }).then((convId) => {
          for (const pp of levelPending) {
            insertSwarmPersona({ ...pp, conversation_id: convId }).catch(() => {});
          }
        }).catch(() => {});
      }

      if (!judgeResult.continue || round >= MAX_ROUNDS) {
        finalDecisions = judgeResult.decisions || [];
        break;
      }

      // Determine next speakers from blackboard conflicts
      const conflictingCodes = bb.getConflictingSpeakers();
      if (conflictingCodes.length > 0) {
        // Map codes back to persona names
        const conflictPersonas = conflictingCodes
          .map(code => CODE_TO_PERSONA[code])
          .filter((p): p is SwarmPersona => !!p && allPersonas.includes(p));
        nextSpeakers = conflictPersonas.length > 0 ? conflictPersonas : allPersonas;
      } else {
        // Judge may also provide next_speakers as persona codes or names
        const requestedSpeakers = judgeResult.next_speakers ?? [];
        if (requestedSpeakers.length > 0) {
          nextSpeakers = requestedSpeakers
            .map((s: string) => CODE_TO_PERSONA[s] ?? s)
            .filter((s: string) => allPersonas.includes(s as SwarmPersona)) as SwarmPersona[];
          if (nextSpeakers.length === 0) nextSpeakers = allPersonas;
        } else {
          nextSpeakers = allPersonas;
        }
      }
    }

    this.lastFingerprint = fp;
    this.lastDecisions = finalDecisions;
    this.lastDebateAt = Date.now();
    return finalDecisions;
  }
}
