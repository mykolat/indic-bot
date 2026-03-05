import { describe, it, expect, vi } from 'vitest';
import { EpisodicAgent } from '../../src/llm/episodic-agent.js';
import type { EmbeddingClient } from '../../src/llm/embedding-client.js';
import type { EpisodicStore, Episode } from '../../src/memory/episodic-store.js';

describe('EpisodicAgent', () => {
    it('retrieves and formats similar experiences', async () => {
        const mockEmbedding = {
            getEmbedding: vi.fn().mockResolvedValue([0.5, 0.5])
        } as unknown as EmbeddingClient;

        const mockStore = {
            search: vi.fn().mockReturnValue([
                { score: 0.95, episode: { textSummary: 'Market chopped. Long failed.', resultPnl: -2 } },
                { score: 0.85, episode: { textSummary: 'High volume breakout.', resultPnl: 5 } }
            ])
        } as unknown as EpisodicStore;

        const agent = new EpisodicAgent(mockEmbedding, mockStore);
        const context = await agent.getRelevantContext('Current market is sideways.');

        expect(mockEmbedding.getEmbedding).toHaveBeenCalledWith('Current market is sideways.');
        expect(context).toContain('Market chopped. Long failed.');
        expect(context).toContain('High volume breakout.');
        expect(context).toContain('-2');
        expect(context).toContain('+5'); // Sign formatted
    });

    it('returns empty string if nothing relevant', async () => {
        const mockEmbedding = { getEmbedding: vi.fn().mockResolvedValue([0.5, 0.5]) } as any;
        const mockStore = { search: vi.fn().mockReturnValue([]) } as any;

        const agent = new EpisodicAgent(mockEmbedding, mockStore);
        const context = await agent.getRelevantContext('Current market is sideways.');

        expect(context).toBe('');
    });
});
