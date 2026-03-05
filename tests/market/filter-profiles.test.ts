import { describe, it, expect } from 'vitest';
import { getFilterProfile } from '../../src/market/filter-profiles.js';
import { MarketRegime } from '../../src/market/regime-classifier.js';

describe('getFilterProfile', () => {
    it('returns bull_trend profile with wider RSI range', () => {
        const profile = getFilterProfile(MarketRegime.BullTrend);
        expect(profile.rsiRange).toEqual([45, 80]);
        expect(profile.volumeMin).toBe(0.6);
        expect(profile.confluenceMin).toBe(2);
    });

    it('returns bear_trend profile', () => {
        const profile = getFilterProfile(MarketRegime.BearTrend);
        expect(profile.rsiRange).toEqual([20, 55]);
        expect(profile.minConfidence).toBe(55);
    });

    it('returns range profile with halved leverage', () => {
        const profile = getFilterProfile(MarketRegime.Range);
        expect(profile.leverageMultiplier).toBe(0.5);
    });

    it('returns breakout profile with high volume requirement', () => {
        const profile = getFilterProfile(MarketRegime.Breakout);
        expect(profile.volumeMin).toBe(1.2);
        expect(profile.confluenceMin).toBe(3);
    });

    it('returns capitulation profile with minimal filters', () => {
        const profile = getFilterProfile(MarketRegime.Capitulation);
        expect(profile.confluenceMin).toBe(1);
        expect(profile.leverageMultiplier).toBe(0.25);
        expect(profile.minConfidence).toBe(45);
    });

    it('all profiles have required fields', () => {
        for (const regime of Object.values(MarketRegime)) {
            const p = getFilterProfile(regime as MarketRegime);
            expect(p).toHaveProperty('rsiRange');
            expect(p).toHaveProperty('volumeMin');
            expect(p).toHaveProperty('confluenceMin');
            expect(p).toHaveProperty('leverageMultiplier');
            expect(p).toHaveProperty('minConfidence');
            expect(p).toHaveProperty('slStyle');
            expect(p).toHaveProperty('tpStyle');
        }
    });
});
