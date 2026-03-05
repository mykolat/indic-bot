import { describe, it, expect } from 'vitest';
import { buildUserPrompt } from '../../src/llm/prompts.js';

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
