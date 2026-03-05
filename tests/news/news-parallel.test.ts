
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingLoop } from '../../src/trading-loop.js';
import { MarketRegime } from '../../src/market/regime-classifier.js';

describe('TradingLoop News Parallel Fetch', () => {
    let mockDeps: any;

    beforeEach(() => {
        mockDeps = {
            pairs: ['BTCUSDT'],
            marketData: {
                getSnapshot: vi.fn().mockResolvedValue({
                    pair: 'BTCUSDT',
                    markPrice: '60000',
                    markPrice4h: '59000',
                    candles1h: Array(24).fill({ close: '60000', high: '61000', low: '59000', volume: '100' }),
                    candles4h: Array(24).fill({ close: '60000', high: '61000', low: '59000', volume: '100' }),
                    openInterest: '1000',
                    fundingRate: '0.0001'
                }),
                getPortfolioState: vi.fn().mockResolvedValue({
                    balanceUsd: 1000,
                    availableUsd: 1000,
                    positions: []
                }),
            },
            llm: { analyze: vi.fn().mockResolvedValue([]), call: vi.fn().mockResolvedValue('{}') },
            orders: { execute: vi.fn() },
            riskManager: { validate: vi.fn().mockReturnValue({ approved: true }) },
            signalBuffer: { drain: vi.fn().mockReturnValue([]) },
            logger: { logAction: vi.fn(), logDecision: vi.fn(), logError: vi.fn() },
            newsCache: {
                shouldRefresh: vi.fn().mockReturnValue(true),
                save: vi.fn(),
                getAnalysis: vi.fn().mockReturnValue({}),
                load: vi.fn().mockReturnValue(null),
                appendHistory: vi.fn(),
                getRecentItems: vi.fn().mockReturnValue([]),
            },
            newsConfig: { refreshIntervalH: 1, maxItems: 10 },
            newsAnalyst: { analyze: vi.fn().mockResolvedValue({ top_signals: [] }) },
            memory: {
                load: vi.fn().mockReturnValue({}),
                save: vi.fn(),
                setStartBalance: vi.fn(),
                getStartBalance: vi.fn().mockReturnValue(1000),
                getHighWaterMark: vi.fn(),
                setHighWaterMark: vi.fn(),
                setLastOrderResult: vi.fn(),
            },
            tradingConfig: { pairs: ['BTCUSDT'], targetReturnPct: 100 },
            memoryKeeper: { read: vi.fn().mockReturnValue(''), updateStats: vi.fn() },
        };
    });

    it('passes news, macro, and memory data to experts', async () => {
        mockDeps.llm.call = vi.fn().mockResolvedValue('{}');
        const mockMacro = {
            fetch: vi.fn().mockResolvedValue({}),
            fetchBTCDominance: vi.fn().mockResolvedValue({})
        };
        const mockMacroAnalyst = { analyze: vi.fn().mockResolvedValue({ risk_score: 5 }) };

        // Set cache to return something
        mockDeps.newsCache.getAnalysis.mockReturnValue({ some: 'data' });
        mockDeps.newsCache.load.mockReturnValue({ analysis: { some: 'data' }, analyzedAt: new Date().toISOString() });
        mockDeps.memoryKeeper.read.mockReturnValue('past memory');

        const loop = new TradingLoop({
            ...mockDeps,
            macroFetcher: mockMacro as any,
            macroAnalyst: mockMacroAnalyst as any,
        });

        await loop.runOnce();

        expect(mockMacro.fetch).toHaveBeenCalled();
        expect(mockMacroAnalyst.analyze).toHaveBeenCalled();

        // Check LLM calls (runLayer1Experts calls llm.call 3 times)
        expect(mockDeps.llm.call).toHaveBeenCalledTimes(3);

        // Verify one of the calls contains news data
        const newsCall = mockDeps.llm.call.mock.calls.find((c: any) => c[0].includes('NewsExpert'));
        expect(newsCall[1]).toContain('data');

        // Verify one of the calls contains macro data
        const macroCall = mockDeps.llm.call.mock.calls.find((c: any) => c[0].includes('MacroExpert'));
        expect(macroCall[1]).toContain('risk_score');

        // Verify one of the calls contains memory data
        const memCall = mockDeps.llm.call.mock.calls.find((c: any) => c[0].includes('MemoryExpert'));
        expect(memCall[1]).toContain('past memory');
    });

    it('fetches from all available sources and deduplicates with priority to CP', async () => {
        const mockRss = {
            fetchNews: vi.fn().mockResolvedValue([
                { title: 'Duplicate News', source: 'RSS', sentiment: 0 },
                { title: 'Unique RSS', source: 'RSS', sentiment: 0 }
            ])
        };
        const mockCP = {
            fetchNews: vi.fn().mockResolvedValue([
                { title: 'Duplicate News', source: 'CryptoPanic', sentiment: 10 },
                { title: 'Unique CP', source: 'CryptoPanic', sentiment: 0 }
            ])
        };

        const loop = new TradingLoop({
            ...mockDeps,
            rssFetcher: mockRss as any,
            newsClient: mockCP as any,
        });

        await loop.runOnce();

        expect(mockRss.fetchNews).toHaveBeenCalled();
        expect(mockCP.fetchNews).toHaveBeenCalled();

        const analystCall = mockDeps.newsAnalyst.analyze.mock.calls[0][0];
        expect(analystCall).toHaveLength(3);

        const duplicateItem = analystCall.find((n: any) => n.title === 'Duplicate News');
        expect(duplicateItem.source).toBe('CryptoPanic');
        expect(duplicateItem.sentiment).toBe(10);
    });
});
