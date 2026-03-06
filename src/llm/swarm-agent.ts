import type { LLMClient } from './client.js';
import type { TradeDecision } from '../risk/manager.js';
import { buildUserPrompt, type EnrichedPromptData, buildExpertSystemPrompt, buildCritiquePrompt, buildRevisePrompt, buildLevelJudgePrompt, type SwarmPersona, type ExpertSummary } from './prompts.js';
import { insertSwarmPersona, insertLlmConversation } from '../db/repository.js';
import { buildSwarmFingerprint, hasChanged } from './swarm-fingerprint.js';

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

function parseCritiqueOutput(raw: string, persona: string): CritiqueOutput | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.critiques)) return { ...parsed, persona };
  } catch {
    const match = raw.match(/\{[\s\S]*"critiques"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.critiques)) return { ...parsed, persona };
      } catch { /* ignore */ }
    }
  }
  console.warn(`[Swarm] Failed to parse ${persona} critique output`);
  return null;
}

function parseReviseOutput(raw: string, persona: string): ReviseOutput | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.revised_probability === 'number') return { ...parsed, persona };
  } catch {
    const match = raw.match(/\{[\s\S]*"revised_probability"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.revised_probability === 'number') return { ...parsed, persona };
      } catch { /* ignore */ }
    }
  }
  console.warn(`[Swarm] Failed to parse ${persona} revise output`);
  return null;
}

function toExpertSummary(eo: ExpertOutput): ExpertSummary {
  return {
    persona: eo.persona,
    thesis: eo.thesis,
    position: eo.position,
    probability_of_success: eo.probability_of_success,
    arguments: eo.arguments,
    key_risks: eo.key_risks,
  };
}

function isHighStakes(data: EnrichedPromptData): boolean {
  for (const pos of data.portfolio.positions) {
    if (Math.abs(pos.unrealizedPnlPct) > 3) return true;
  }
  const totalMargin = data.portfolio.positions.reduce(
    (sum, p) => sum + (p.entryPrice * (p as any).quantity || 0) / (p.leverage || 1),
    0,
  );
  if (data.portfolio.balanceUsd > 0 && totalMargin / data.portfolio.balanceUsd > 0.3) return true;
  return false;
}

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
The Devil's Advocate's job is to find flaws — give extra weight to risks they identify.
Experts who changed their mind after critique show intellectual honesty — weight their revised view higher.

${sections.join('\n\n')}

Based on these expert opinions, produce the final consensus trading decision.
If experts strongly disagree, lean towards HOLD.
If the Risk Manager flags critical danger AND the Devil's Advocate agrees, lean towards CLOSE or HOLD.

You MUST respond with valid JSON:
{"decisions": [{"pair": "<pair>", "action": "LONG|SHORT|HOLD|CLOSE", "size_pct": <number>, "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "confidence": <0-100>, "reasoning": "<string>"}], "next_check_minutes": <1-30>}`;
}

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
    const MAX_LEVELS = 5;
    const allPersonas: SwarmPersona[] = ['risk_manager', 'market_structure', 'devils_advocate'];
    if (this.grokLlm) allPersonas.push('narrative_expert');

    const conversationHistory: Array<{ persona: string; content: string; vote?: string; phase: number }> = [];
    const pendingPersonasByLevel = new Map<number, Array<{ persona: string; model: string; raw_response: string; vote?: string; confidence?: number; reasoning?: string; phase: number }>>();

    let finalDecisions: TradeDecision[] = [];
    let nextSpeakers: SwarmPersona[] = allPersonas;

    for (let level = 1; level <= MAX_LEVELS; level++) {
      const speakers = level === 1 ? allPersonas : nextSpeakers;
      console.log(`[Swarm] Level ${level}: ${speakers.join(', ')}`);

      const contextSuffix = level > 1
        ? '\n\n== PRIOR DEBATE MESSAGES ==\n' + conversationHistory
          .map(m => `[L${m.phase}] ${m.persona.toUpperCase()}${m.vote ? ` (${m.vote})` : ''}: ${m.content}`)
          .join('\n\n')
        : '';

      const expertCalls = speakers.map(p => {
        const isGrok = p === 'narrative_expert' && this.grokLlm;
        return isGrok
          ? this.grokLlm.call(buildExpertSystemPrompt(p), userPrompt + contextSuffix, 'grok-4-1-fast-reasoning')
          : this.llm.call(buildExpertSystemPrompt(p), userPrompt + contextSuffix);
      });

      const results = await Promise.allSettled(expertCalls);
      const levelPending: typeof pendingPersonasByLevel extends Map<number, infer V> ? V : never = [];

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 'fulfilled') {
          const eo = parseExpertOutput(res.value, speakers[i]);
          if (speakers[i] === 'narrative_expert') this.sourceHealth?.recordSuccess('grok-narrative');
          conversationHistory.push({
            persona: speakers[i],
            content: eo?.thesis || res.value.slice(0, 500),
            vote: eo?.position,
            phase: level,
          });
          if (this.sessionId) {
            levelPending.push({
              persona: speakers[i],
              model: speakers[i] === 'narrative_expert' ? 'grok' : 'codex',
              raw_response: res.value,
              vote: eo?.position,
              confidence: eo?.confidence,
              reasoning: eo?.thesis || res.value.slice(0, 500),
              phase: level,
            });
          }
        } else {
          console.warn(`[Swarm] ${speakers[i]} failed at L${level}:`, results[i].status === 'rejected' ? (results[i] as PromiseRejectedResult).reason : '');
          if (speakers[i] === 'narrative_expert') {
            const reason = results[i].status === 'rejected' ? (results[i] as PromiseRejectedResult).reason : new Error('unknown');
            this.sourceHealth?.recordFailure('grok-narrative', reason?.message ?? String(reason));
          }
        }
      }

      pendingPersonasByLevel.set(level, levelPending);

      if (conversationHistory.filter(m => m.phase === level).length === 0) {
        console.error('[Swarm] All sub-agents failed at level', level);
        throw new Error('Swarm failure');
      }

      // Judge for this level
      const judgePrompt = buildLevelJudgePrompt(level, conversationHistory, MAX_LEVELS);
      let rawJudge: string;
      try {
        rawJudge = await this.llm.call(judgePrompt, userPrompt);
      } catch (e) {
        console.error(`[Swarm] Judge failed at L${level}:`, e);
        return [];
      }

      conversationHistory.push({ persona: 'judge', content: rawJudge.slice(0, 500), phase: level });

      // Parse judge response
      let judgeResult: any;
      try {
        judgeResult = JSON.parse(rawJudge);
      } catch {
        const match = rawJudge.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
        if (match) { try { judgeResult = JSON.parse(match[0]); } catch { /* ignore */ } }
      }

      if (!judgeResult) {
        console.error(`[Swarm] Judge parse failed at L${level}`);
        return [];
      }

      console.log(`[Swarm] L${level} Judge: continue=${judgeResult.continue}, verdict="${(judgeResult.verdict || '').slice(0, 80)}"`);

      const ncm = judgeResult.next_check_minutes;
      if (typeof ncm === 'number' && Number.isFinite(ncm) && ncm >= 1 && ncm <= 30) {
        this.llm.lastNextCheckMinutes = ncm;
      }

      // Store DB for this level
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
          label: `judge_level_${level}`,
          system_prompt: judgePrompt,
          user_prompt: userPrompt,
          raw_response: rawJudge,
        }).then((convId) => {
          for (const pp of levelPending) {
            insertSwarmPersona({ ...pp, conversation_id: convId }).catch(() => {});
          }
        }).catch(() => {});
      }

      if (!judgeResult.continue || level >= MAX_LEVELS) {
        finalDecisions = judgeResult.decisions || [];
        break;
      }

      // Prepare next speakers
      const requestedSpeakers = judgeResult.next_speakers ?? [];
      nextSpeakers = requestedSpeakers.length > 0
        ? requestedSpeakers.filter((s: string) => allPersonas.includes(s as SwarmPersona)) as SwarmPersona[]
        : allPersonas;
    }

    this.lastFingerprint = fp;
    this.lastDecisions = finalDecisions;
    this.lastDebateAt = Date.now();
    return finalDecisions;
  }
}
