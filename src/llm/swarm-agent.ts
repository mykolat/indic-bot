import type { LLMClient } from './client.js';
import type { TradeDecision } from '../risk/manager.js';
import { buildUserPrompt, type EnrichedPromptData, buildExpertSystemPrompt, buildCritiquePrompt, buildRevisePrompt, type SwarmPersona, type ExpertSummary } from './prompts.js';
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

    console.log('[Swarm] Multi-Agent Debate: RiskMgr, MarketStructure, Devil + Judge');

    const personas: SwarmPersona[] = [
      'risk_manager',
      'market_structure',
      'devils_advocate',
    ];

    const expertCalls = personas.map(p =>
      this.llm.call(buildExpertSystemPrompt(p), userPrompt),
    );

    if (this.grokLlm) {
      personas.push('narrative_expert');
      expertCalls.push(
        this.grokLlm.call(buildExpertSystemPrompt('narrative_expert'), userPrompt, 'grok-4-1-fast-reasoning'),
      );
    }

    // Stage 1: Generate
    const results = await Promise.allSettled(expertCalls);
    const rawTexts: string[] = [];
    const expertOutputs: (ExpertOutput | null)[] = [];
    const pendingPersonas: Array<{ persona: string; model: string; raw_response: string; vote?: string; confidence?: number; reasoning?: string }> = [];

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        rawTexts.push(res.value);
        expertOutputs.push(parseExpertOutput(res.value, personas[i]));
        if (personas[i] === 'narrative_expert') this.sourceHealth?.recordSuccess('grok-narrative');
        if (this.sessionId) {
          const eo = expertOutputs[expertOutputs.length - 1];
          pendingPersonas.push({
            persona: personas[i],
            model: personas[i] === 'narrative_expert' ? 'grok' : 'codex',
            raw_response: res.value,
            vote: eo?.position,
            confidence: eo?.confidence,
            reasoning: eo?.thesis || res.value.slice(0, 500),
          });
        }
      } else {
        console.warn(`[Swarm] Sub-agent ${personas[i]} failed:`, res.reason);
        if (personas[i] === 'narrative_expert') this.sourceHealth?.recordFailure('grok-narrative', res.reason?.message ?? String(res.reason));
        rawTexts.push('');
        expertOutputs.push(null);
      }
    }

    const validExperts = expertOutputs.filter((eo): eo is ExpertOutput => eo !== null);
    if (validExperts.length === 0) {
      console.error('[Swarm] All sub-agents failed, aborting consensus.');
      throw new Error('Swarm failure');
    }

    console.log(`[Swarm] Stage 1 (Generate): ${validExperts.length}/${personas.length} experts responded`);

    // Stage 2: Critique — all experts critique each other
    const expertSummaries = validExperts.map(toExpertSummary);
    let critiqueOutputs: (CritiqueOutput | null)[] | undefined;

    // Skip critique if all experts unanimously vote HOLD
    const allHold = validExperts.length > 0 && validExperts.every(eo => eo.position === 'HOLD');

    if (!allHold && validExperts.length >= 2) {
      console.log('[Swarm] Stage 2 (Critique): experts reviewing each other...');
      const critiqueCalls = personas.map((p, i) => {
        if (!expertOutputs[i]) return Promise.resolve('');
        return this.llm.call(
          buildCritiquePrompt(p, expertSummaries),
          userPrompt,
        );
      });

      const critiqueResults = await Promise.allSettled(critiqueCalls);
      critiqueOutputs = critiqueResults.map((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          return parseCritiqueOutput(r.value, personas[i]);
        }
        return null;
      });

      const validCritiques = critiqueOutputs.filter(Boolean).length;
      console.log(`[Swarm] Stage 2: ${validCritiques}/${personas.length} critiques parsed`);
    }

    // Stage 3: Revise — gated on high-stakes
    let reviseOutputs: (ReviseOutput | null)[] | undefined;

    if (critiqueOutputs && isHighStakes(data)) {
      console.log('[Swarm] Stage 3 (Revise): HIGH-STAKES detected — experts revising positions...');
      const reviseCalls = personas.map((p, i) => {
        const eo = expertOutputs[i];
        if (!eo) return Promise.resolve('');

        const critiquesOfMe = (critiqueOutputs ?? [])
          .filter((c): c is CritiqueOutput => c !== null && c.persona !== p)
          .flatMap(c => c.critiques.filter(cr => cr.target_persona === p).map(cr => ({
            from: c.persona,
            agrees: cr.agrees,
            critique: cr.critique,
            counter_argument: cr.counter_argument,
          })));

        return this.llm.call(
          buildRevisePrompt(p, { ...toExpertSummary(eo), confidence: eo.confidence }, critiquesOfMe),
          userPrompt,
        );
      });

      const reviseResults = await Promise.allSettled(reviseCalls);
      reviseOutputs = reviseResults.map((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          return parseReviseOutput(r.value, personas[i]);
        }
        return null;
      });

      const validRevisions = reviseOutputs.filter(Boolean).length;
      console.log(`[Swarm] Stage 3: ${validRevisions}/${personas.length} revisions parsed`);
    }

    // Judge
    const judgeSystem = buildJudgePrompt(expertOutputs, rawTexts, personas, critiqueOutputs, reviseOutputs);

    let rawConsensus: string;
    try {
      rawConsensus = await this.llm.call(judgeSystem, userPrompt);
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
          system_prompt: judgeSystem,
          user_prompt: userPrompt,
          raw_response: rawConsensus,
        }).then((convId) => {
          // Insert all pending personas with judge's conversation_id
          for (const pp of pendingPersonas) {
            insertSwarmPersona({ ...pp, conversation_id: convId }).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[Swarm] Consensus LLM call failed:', e);
      return [];
    }

    let jsonStr: string | undefined;
    try {
      JSON.parse(rawConsensus);
      jsonStr = rawConsensus;
    } catch {
      const match = rawConsensus.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\]\s*[\s\S]*\}/);
      if (match) {
        jsonStr = match[0];
      }
    }

    if (!jsonStr || !jsonStr.includes('"decisions"')) {
      console.error('[Swarm] Consensus parser failed to find JSON');
      return [];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      const ncm = parsed.next_check_minutes;
      if (typeof ncm === 'number' && Number.isFinite(ncm) && ncm >= 1 && ncm <= 30) {
        this.llm.lastNextCheckMinutes = ncm;
      }
      const decisions = parsed.decisions || [];
      this.lastFingerprint = fp;
      this.lastDecisions = decisions;
      this.lastDebateAt = Date.now();
      return decisions;
    } catch (e) {
      console.error('[Swarm] Consensus JSON invalid', e);
      return [];
    }
  }
}
