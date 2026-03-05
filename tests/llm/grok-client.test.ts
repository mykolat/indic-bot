import { describe, it, expect, vi } from 'vitest';
import { GrokClient } from '../../src/llm/grok-client.js';

describe('GrokClient', () => {
    it('calls xAI API correctly', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'Test response' } }] })
        });
        const client = new GrokClient('fake-key');
        const res = await client.call('Sys', 'User', 'grok-4-1-fast-reasoning');
        expect(res).toBe('Test response');
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.x.ai/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('grok-4-1-fast-reasoning')
            })
        );
    });
});
