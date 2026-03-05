import { describe, it, expect, vi } from 'vitest';
import { FlashCrashScanner } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
    it('detects panic using non-reasoning model', async () => {
        const mockGrok = {
            call: vi.fn().mockResolvedValue('PANIC')
        } as any;

        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();

        expect(res).toBe('PANIC');
        expect(mockGrok.call).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), 'grok-4-1-fast-non-reasoning'
        );
    });
});
