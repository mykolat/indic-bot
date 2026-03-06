import { describe, it, expect, vi, afterEach } from 'vitest';
import { GrokClient } from '../../src/llm/grok-client.js';

describe('GrokClient', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

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

    it('healthCheck returns ok:true on valid key', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: '' } }] })
        });
        const client = new GrokClient('fake-key');
        const result = await client.healthCheck();
        expect(result).toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalled();
        const callArgs = (global.fetch as any).mock.calls[0];
        expect(callArgs[1].body).toContain('"max_tokens":1');
    });

    it('healthCheck returns ok:false on API error', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: 'Unauthorized'
        });
        const client = new GrokClient('fake-key');
        const result = await client.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('401');
    });

    it('healthCheck returns ok:false when no key', async () => {
        global.fetch = vi.fn();
        const client = new GrokClient('');
        const result = await client.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('API key');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('healthCheck returns ok:false on network error', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const client = new GrokClient('fake-key');
        const result = await client.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('ECONNREFUSED');
    });

    it('call() logs warning once when key is empty', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const client = new GrokClient('');
        await client.call('Sys', 'User');
        await client.call('Sys', 'User');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok]'));
        warnSpy.mockRestore();
    });
});
