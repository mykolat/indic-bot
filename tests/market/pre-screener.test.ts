import { describe, it, expect } from 'vitest';
import { PreScreener, type ScreenVerdict } from '../../src/market/pre-screener.js';

const makeInd = (overrides: Partial<any> = {}) => ({
  rsi: 50, ema20: 100, ema50: 99, trend: 'bullish' as const,
  volumeRatio: 1.0, vwap: 100, adx: 30,
  macd: 0, macdSignal: 0, macdHistogram: 0,
  bollingerUpper: 110, bollingerMiddle: 100, bollingerLower: 90,
  bollingerBandwidth: 20, bollingerPercentB: 50, atr: 2,
  ...overrides,
});

describe('PreScreener', () => {
  const screener = new PreScreener();

  it('passes pair with open position regardless of indicators', () => {
    const result = screener.screen({
      pair: 'BTCUSDT',
      ind1h: makeInd({ volumeRatio: 0.1, trend: 'neutral' }),
      ind4h: makeInd({ trend: 'neutral' }),
      regime: 'Range',
      confluence: 0,
      hasPosition: true,
    });
    expect(result.verdict).toBe('manage');
  });

  it('warns (not blocks) when 1h and 4h trends conflict', () => {
    const result = screener.screen({
      pair: 'ETHUSDT',
      ind1h: makeInd({ trend: 'bearish' }),
      ind4h: makeInd({ trend: 'bullish' }),
      regime: 'BearTrend',
      confluence: 3,
      hasPosition: false,
    });
    expect(result.verdict).toBe('pass');
    expect(result.warning).toBe('4h_conflict');
  });

  it('holds pair when volume below regime minimum', () => {
    const result = screener.screen({
      pair: 'SOLUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 0.3 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 2,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('low_volume');
  });

  it('holds pair when RSI out of regime range (oversold in BearTrend)', () => {
    const result = screener.screen({
      pair: 'BNBUSDT',
      ind1h: makeInd({ trend: 'bearish', rsi: 18, volumeRatio: 1.0 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 2,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('rsi_extreme');
  });

  it('holds pair when confluence below regime minimum', () => {
    const result = screener.screen({
      pair: 'XRPUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 1.0, rsi: 40 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 1,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('low_confluence');
  });

  it('holds pair with no usable data', () => {
    const result = screener.screen({
      pair: 'PEPEUSDT',
      ind1h: null,
      ind4h: null,
      regime: 'Range',
      confluence: 0,
      hasPosition: false,
    });
    expect(result.verdict).toBe('hold');
    expect(result.reason).toBe('no_data');
  });

  it('passes pair when all checks pass', () => {
    const result = screener.screen({
      pair: 'LTCUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 1.2, rsi: 40 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'BearTrend',
      confluence: 3,
      hasPosition: false,
    });
    expect(result.verdict).toBe('pass');
  });

  it('passes pair in Capitulation (permissive filters)', () => {
    const result = screener.screen({
      pair: 'AVAXUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 0.5, rsi: 25 }),
      ind4h: makeInd({ trend: 'bearish' }),
      regime: 'Capitulation',
      confluence: 1,
      hasPosition: false,
    });
    expect(result.verdict).toBe('pass');
  });

  it('always passes BTC even if filters fail', () => {
    const result = screener.screen({
      pair: 'BTCUSDT',
      ind1h: makeInd({ trend: 'bearish', volumeRatio: 0.1 }),
      ind4h: makeInd({ trend: 'bullish' }),
      regime: 'Range',
      confluence: 0,
      hasPosition: false,
    });
    expect(result.verdict).toBe('pass');
  });

  it('screenAll returns categorized results', () => {
    const results = screener.screenAll([
      { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: true },
      { pair: 'ETHUSDT', ind1h: makeInd({ volumeRatio: 0.1 }), ind4h: makeInd(), regime: 'Range', confluence: 0, hasPosition: false },
    ]);
    expect(results.passed).toHaveLength(1);
    expect(results.passed[0].pair).toBe('BTCUSDT');
    expect(results.held).toHaveLength(1);
    expect(results.held[0].pair).toBe('ETHUSDT');
  });

  describe('margin modes', () => {
    it('no_margin: only passes positions + BTC', () => {
      const results = screener.screenAll([
        { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
        { pair: 'ETHUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: true },
        { pair: 'SOLUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
      ], { margin: { availableUsd: 3, walletBalanceUsd: 187, minPositionUsd: 5 } });
      expect(results.marginMode).toBe('no_margin');
      expect(results.passed.map(p => p.pair)).toEqual(['BTCUSDT', 'ETHUSDT']);
      expect(results.held).toHaveLength(1);
      expect(results.held[0].reason).toBe('no_margin');
    });

    it('low_margin: passes all filtered pairs (LLM picks best)', () => {
      const results = screener.screenAll([
        { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
        { pair: 'ETHUSDT', ind1h: makeInd({ volumeRatio: 0.1 }), ind4h: makeInd(), regime: 'Range', confluence: 0, hasPosition: false },
      ], { margin: { availableUsd: 15, walletBalanceUsd: 187, minPositionUsd: 5 } });
      expect(results.marginMode).toBe('low_margin');
      expect(results.passed).toHaveLength(1);
    });

    it('normal mode when margin sufficient', () => {
      const results = screener.screenAll([
        { pair: 'BTCUSDT', ind1h: makeInd(), ind4h: makeInd(), regime: 'Range', confluence: 3, hasPosition: false },
      ], { margin: { availableUsd: 100, walletBalanceUsd: 187, minPositionUsd: 5 } });
      expect(results.marginMode).toBe('normal');
    });
  });
});
