import { describe, it, expect, vi } from 'vitest';
import { runLayer1Experts } from '../../src/llm/agents.js';

describe('runLayer1Experts', () => {
    it('returns aggregated reports from all mini-agents', async () => {
        const mockLlmClient = { call: vi.fn().mockResolvedValue('{"score": 7}') };

        const results = await runLayer1Experts(mockLlmClient as any, {
            newsData: '...',
            macroData: '...',
            soulData: '...'
        });

        expect(results).toHaveProperty('newsReport');
        expect(results).toHaveProperty('macroReport');
        expect(results).toHaveProperty('soulReport');
        expect(mockLlmClient.call).toHaveBeenCalledTimes(3);
    });
});
