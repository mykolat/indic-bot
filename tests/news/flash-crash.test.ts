import { describe, it, expect, vi } from 'vitest';
import { FlashCrashScanner } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
    it('returns IGNORE when no grok client', async () => {
        const scanner = new FlashCrashScanner(null);
        const res = await scanner.scan();
        expect(res.verdict).toBe('IGNORE');
        expect(res.grokSays).toBe('IGNORE');
    });

    it('returns IGNORE when Grok says IGNORE', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('IGNORE') } as any;
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();
        expect(res.verdict).toBe('IGNORE');
        expect(res.grokSays).toBe('IGNORE');
    });

    it('returns UNCONFIRMED when Grok PANIC but no market data', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();
        expect(res.verdict).toBe('UNCONFIRMED');
        expect(res.grokSays).toBe('PANIC');
    });

    it('returns PANIC when Grok PANIC + price drop >3%', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const mockMarket = {
          getRecentCandles: vi.fn().mockResolvedValue([
            { close: '100', volume: '10' },
            { close: '99', volume: '10' },
            { close: '98', volume: '10' },
            { close: '97', volume: '10' },
            { close: '96', volume: '12' }, // -4% drop
          ]),
        };
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan(mockMarket, ['BTCUSDT']);
        expect(res.verdict).toBe('PANIC');
        expect(res.grokSays).toBe('PANIC');
        expect(res.priceDropPct).toBeLessThan(-3);
    });

    it('returns PANIC when Grok PANIC + volume spike >3x', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const mockMarket = {
          getRecentCandles: vi.fn().mockResolvedValue([
            { close: '100', volume: '10' },
            { close: '100', volume: '10' },
            { close: '100', volume: '10' },
            { close: '100', volume: '10' },
            { close: '99', volume: '50' }, // 5x volume spike, only -1% drop
          ]),
        };
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan(mockMarket, ['BTCUSDT']);
        expect(res.verdict).toBe('PANIC');
        expect(res.volumeSpike).toBeGreaterThan(3);
    });

    it('returns UNCONFIRMED when Grok PANIC but price/vol normal', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const mockMarket = {
          getRecentCandles: vi.fn().mockResolvedValue([
            { close: '100', volume: '10' },
            { close: '100', volume: '10' },
            { close: '100', volume: '10' },
            { close: '100', volume: '10' },
            { close: '99.5', volume: '11' }, // -0.5% drop, 1.1x vol
          ]),
        };
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan(mockMarket, ['BTCUSDT']);
        expect(res.verdict).toBe('UNCONFIRMED');
    });

    it('cooldown: returns IGNORE within 15min of last PANIC', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const mockMarket = {
          getRecentCandles: vi.fn().mockResolvedValue([
            { close: '100', volume: '10' },
            { close: '99', volume: '10' },
            { close: '98', volume: '10' },
            { close: '97', volume: '10' },
            { close: '96', volume: '12' },
          ]),
        };
        const scanner = new FlashCrashScanner(mockGrok);

        // First scan → PANIC
        const first = await scanner.scan(mockMarket, ['BTCUSDT']);
        expect(first.verdict).toBe('PANIC');

        // Second scan → IGNORE (cooldown)
        const second = await scanner.scan(mockMarket, ['BTCUSDT']);
        expect(second.verdict).toBe('IGNORE');
        expect(second.reason).toBe('cooldown active');
    });

    it('records success in sourceHealth', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('IGNORE') } as any;
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const scanner = new FlashCrashScanner(mockGrok, mockHealth);
        await scanner.scan();
        expect(mockHealth.recordSuccess).toHaveBeenCalledWith('grok-flash-crash');
    });

    it('records failure in sourceHealth', async () => {
        const mockGrok = { call: vi.fn().mockRejectedValue(new Error('connection refused')) } as any;
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const scanner = new FlashCrashScanner(mockGrok, mockHealth);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await scanner.scan();
        expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-flash-crash', 'connection refused');
        vi.restoreAllMocks();
    });

    it('uses non-reasoning model for speed', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('IGNORE') } as any;
        const scanner = new FlashCrashScanner(mockGrok);
        await scanner.scan();
        expect(mockGrok.call).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), 'grok-4-1-fast-non-reasoning'
        );
    });
});
