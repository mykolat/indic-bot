import type { LLMClient } from './client.js';
import type { TradeDecision } from '../risk/manager.js';
import { buildUserPrompt, type EnrichedPromptData, buildSwarmPersonaPrompt, buildConsensusPrompt, type SwarmPersona } from './prompts.js';

export class SwarmAgent {
    constructor(private llm: LLMClient, private grokLlm?: any) { }

    async getConsensus(data: EnrichedPromptData): Promise<TradeDecision[]> {
        const userPrompt = buildUserPrompt(data);

        console.log('[Swarm] Waking up sub-agents (Bull, Bear, RiskManager, NarrativeExpert?)...');

        const personas: SwarmPersona[] = ['permabull', 'permabear', 'paranoid_risk_manager'];
        const expertCalls = personas.map(p => this.llm.call(buildSwarmPersonaPrompt(p), userPrompt));

        if (this.grokLlm) {
            personas.push('narrative_expert');
            expertCalls.push(this.grokLlm.call(buildSwarmPersonaPrompt('narrative_expert'), userPrompt, 'grok-4-1-fast-reasoning'));
        }

        const results = await Promise.allSettled(expertCalls);
        const expertDecisions: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            if (res.status === 'fulfilled') {
                expertDecisions.push(`[${personas[i].toUpperCase()}]:\n${res.value}`);
            } else {
                console.warn(`[Swarm] Sub-agent ${personas[i]} failed:`, res.reason);
            }
        }

        if (expertDecisions.length === 0) {
            console.error('[Swarm] All sub-agents failed, aborting consensus.');
            throw new Error('Swarm failure');
        }

        console.log(`[Swarm] Aggregating ${expertDecisions.length} opinions. Synthesizing consensus...`);
        const consensusPrompt = buildConsensusPrompt(expertDecisions);

        // Use the LLMClient's analyze method for the final call to get valid parsed JSON
        // but we need to override the system prompt for that specific call.
        // Since LLMClient.analyze doesn't accept a system prompt override easily, we'll use .call 
        // and parse it manually exactly like LLMClient does.

        const rawConsensus = await this.llm.call(consensusPrompt, userPrompt);

        let jsonMatch = rawConsensus.match(/\{[^{}]*"decisions"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/);
        if (!jsonMatch) jsonMatch = rawConsensus.match(/\{[\s\S]*"decisions"[\s\S]*\}/);

        if (!jsonMatch) {
            console.error('[Swarm] Consensus parser failed to find JSON');
            return [];
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            this.llm.lastNextCheckMinutes = parsed.next_check_minutes;
            return parsed.decisions || [];
        } catch (e) {
            console.error('[Swarm] Consensus JSON invalid', e);
            return [];
        }
    }
}
