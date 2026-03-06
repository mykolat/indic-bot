import { describe, it, expect, vi } from 'vitest';
import { FlashCrashScanner } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
    it('detects panic using non-reasoning model', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();
        expect(res).toBe('PANIC');
        expect(mockGrok.call).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), 'grok-4-1-fast-non-reasoning'
        );
    });

    it('returns IGNORE when grokClient is null', async () => {
        const scanner = new FlashCrashScanner(null);
        const res = await scanner.scan();
        expect(res).toBe('IGNORE');
    });

    it('logs error instead of swallowing', async () => {
        const mockGrok = { call: vi.fn().mockRejectedValue(new Error('API timeout')) } as any;
        const scanner = new FlashCrashScanner(mockGrok);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await scanner.scan();

        expect(res).toBe('IGNORE');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FlashCrash]'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API timeout'));
        warnSpy.mockRestore();
    });

    it('records success in sourceHealth', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('IGNORE') } as any;
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const scanner = new FlashCrashScanner(mockGrok, mockHealth);

        await scanner.scan();

        expect(mockHealth.recordSuccess).toHaveBeenCalledWith('grok-flash-crash');
        expect(mockHealth.recordFailure).not.toHaveBeenCalled();
    });

    it('records failure in sourceHealth', async () => {
        const mockGrok = { call: vi.fn().mockRejectedValue(new Error('connection refused')) } as any;
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const scanner = new FlashCrashScanner(mockGrok, mockHealth);
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await scanner.scan();

        expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-flash-crash', 'connection refused');
        expect(mockHealth.recordSuccess).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
