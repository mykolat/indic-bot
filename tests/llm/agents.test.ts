import { describe, it, expect, vi } from 'vitest';
import { runLayer1Experts } from '../../src/llm/agents.js';

describe('runLayer1Experts', () => {
    it('returns aggregated reports from all mini-agents', async () => {
        const mockLlmClient = { call: vi.fn().mockResolvedValue('{"score": 7}') };

        const results = await runLayer1Experts(mockLlmClient as any, {
            newsData: '...',
            macroData: '...',
            memoryData: 'We lost heavily in choppy markets yesterday.'
        });

        expect(results).toHaveProperty('newsReport');
        expect(results).toHaveProperty('macroReport');
        expect(results).toHaveProperty('memoryReport');
        expect(mockLlmClient.call).toHaveBeenCalledTimes(3);
    });

    it('returns partial results when one expert fails', async () => {
        const mockLlmClient = {
            call: vi.fn()
                .mockResolvedValueOnce('news ok')
                .mockRejectedValueOnce(new Error('macro timeout'))
                .mockResolvedValueOnce('memory ok')
        };

        const results = await runLayer1Experts(mockLlmClient as any, {
            newsData: '...', macroData: '...', memoryData: '...'
        });

        expect(results.newsReport).toBe('news ok');
        expect(results.macroReport).toBe('');
        expect(results.memoryReport).toBe('memory ok');
    });

    it('returns all empty when all experts fail', async () => {
        const mockLlmClient = {
            call: vi.fn().mockRejectedValue(new Error('API down'))
        };

        const results = await runLayer1Experts(mockLlmClient as any, {
            newsData: '...', macroData: '...', memoryData: '...'
        });

        expect(results.newsReport).toBe('');
        expect(results.macroReport).toBe('');
        expect(results.memoryReport).toBe('');
    });
});
