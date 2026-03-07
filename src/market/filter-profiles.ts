import { MarketRegime } from './regime-classifier.js';

export interface FilterProfile {
    rsiRange: [number, number];     // [min, max] for entry
    volumeMin: number;              // minimum volume ratio
    confluenceMin: number;          // minimum confluence factors (out of 5)
    leverageMultiplier: number;     // multiply config.maxLeverage by this
    minConfidence: number;          // minimum LLM confidence
    slStyle: 'trailing' | 'fixed' | 'atr' | 'range';
    tpStyle: 'trailing' | 'fixed' | 'momentum' | 'range' | 'dca';
}

const PROFILES: Record<MarketRegime, FilterProfile> = {
    [MarketRegime.BullTrend]: {
        rsiRange: [45, 80],
        volumeMin: 0.6,
        confluenceMin: 2,
        leverageMultiplier: 1,
        minConfidence: 50,
        slStyle: 'trailing',
        tpStyle: 'trailing',
    },
    [MarketRegime.BearTrend]: {
        rsiRange: [20, 55],
        volumeMin: 0.4,
        confluenceMin: 2,
        leverageMultiplier: 1,
        minConfidence: 55,
        slStyle: 'fixed',
        tpStyle: 'fixed',
    },
    [MarketRegime.Range]: {
        rsiRange: [30, 70],
        volumeMin: 0.4,
        confluenceMin: 2,
        leverageMultiplier: 0.5,
        minConfidence: 50,
        slStyle: 'range',
        tpStyle: 'range',
    },
    [MarketRegime.Breakout]: {
        rsiRange: [0, 100],  // any RSI
        volumeMin: 1.2,
        confluenceMin: 3,
        leverageMultiplier: 1,
        minConfidence: 60,
        slStyle: 'atr',
        tpStyle: 'momentum',
    },
    [MarketRegime.Capitulation]: {
        rsiRange: [0, 100],  // any RSI
        volumeMin: 0.35,
        confluenceMin: 1,
        leverageMultiplier: 0.25,
        minConfidence: 45,
        slStyle: 'fixed',
        tpStyle: 'dca',
    },
};

export function getFilterProfile(regime: MarketRegime): FilterProfile {
    return PROFILES[regime];
}
