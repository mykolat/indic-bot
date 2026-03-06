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

    it('returns 0 (not NaN) for mismatched vector lengths', () => {
        const a = [1, 2, 3, 4, 5];
        const b = [1, 2];
        const result = cosineSimilarity(a, b);
        expect(Number.isNaN(result)).toBe(false);
        expect(result).toBe(0);
    });

    it('returns 0 for empty vectors', () => {
        expect(cosineSimilarity([], [])).toBe(0);
    });

    it('throws on missing embedding in API response', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ data: [] })
        });

        const client = new EmbeddingClient('fake-token');
        await expect(client.getEmbedding('test')).rejects.toThrow('missing data.data[0].embedding');
    });
});
