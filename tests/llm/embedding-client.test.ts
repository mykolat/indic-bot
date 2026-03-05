import { describe, it, expect, vi } from 'vitest';
import { EmbeddingClient, cosineSimilarity } from '../../src/llm/embedding-client.js';

describe('EmbeddingClient', () => {
    it('fetches embeddings', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
        });

        const client = new EmbeddingClient('fake-token');
        const vector = await client.getEmbedding('test text');

        expect(vector).toEqual([0.1, 0.2, 0.3]);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.openai.com/v1/embeddings',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('text-embedding-3-small')
            })
        );
    });

    it('computes cosine similarity correctly', () => {
        const v1 = [1, 0, 0];
        const v2 = [0, 1, 0];
        const v3 = [1, 1, 0];

        expect(cosineSimilarity(v1, v2)).toBe(0);
        expect(cosineSimilarity(v1, v1)).toBe(1);
        expect(cosineSimilarity(v1, v3)).toBeCloseTo(0.707);
    });
});
