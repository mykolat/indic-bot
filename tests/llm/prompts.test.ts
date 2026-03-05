import { describe, it, expect } from 'vitest';
import { buildUserPrompt, buildSwarmPersonaPrompt, buildConsensusPrompt } from '../../src/llm/prompts.js';

describe('buildUserPrompt', () => {
    it('should inject filterWarning if provided', () => {
        const prompt = buildUserPrompt({
            snapshots: [],
            indicators: new Map(),
            portfolio: { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 },
            signals: [],
            news: [],
            fearGreed: { value: 50, label: 'Neutral' },
            filterWarning: 'Volume 0.3x < 0.6x',
        });
        expect(prompt).toContain('>>> ⚠️ SHARK MODE WARNING ⚠️ <<<');
        expect(prompt).toContain('System technical filters FAILED: Volume 0.3x < 0.6x');
    });
});

describe('Swarm Prompts', () => {
    it('builds persona specific system prompts', () => {
        const bull = buildSwarmPersonaPrompt('permabull');
        expect(bull).toContain('You are an ultra-aggressive PERMABULL');
        expect(bull).toContain('MULTI-TIMEFRAME CONFIRMATION'); // inherits base rules

        const bear = buildSwarmPersonaPrompt('permabear');
        expect(bear).toContain('You are an ultra-aggressive PERMABEAR');

        const risk = buildSwarmPersonaPrompt('paranoid_risk_manager');
        expect(risk).toContain('You are a PARANOID RISK MANAGER');
    });

    it('builds consensus prompt', () => {
        const prompt = buildConsensusPrompt(['bull says long', 'bear says short', 'risk says hold']);
        expect(prompt).toContain('You are the SWARM CONSENSUS JUDGE');
        expect(prompt).toContain('bull says long');
        expect(prompt).toContain('bear says short');
        expect(prompt).toContain('Respond ONLY with valid JSON');
    });
});
