import type { Indicators } from '../indicators/technical.js';

export enum MarketRegime {
  BullTrend = 'BullTrend',
  BearTrend = 'BearTrend',
  Range = 'Range',
  Breakout = 'Breakout',
  Capitulation = 'Capitulation',
  Scalping = 'Scalping',
}

export interface RegimeResult {
  regime: MarketRegime;
  confidence: number;
  factors: string[];
}

export interface RegimeContext {
  prevAtr?: number;
}

export function classifyRegime(
  indicators: Indicators,
  currentPrice: number,
  fearGreed: { value: number },
  ctx?: RegimeContext,
): RegimeResult {
  const factors: string[] = [];

  // --- Priority 1: Capitulation ---
  // F&G alone does NOT trigger Capitulation — panic is not a directional signal.
  // Capitulation requires extreme volume (real sell-off) OR F&G < 15 + volume > 1.5x.
  const isVolumeCapitulation = indicators.volumeRatio > 3;
  const isFgPlusVolume = fearGreed.value < 15 && indicators.volumeRatio > 1.5;

  if (isVolumeCapitulation || isFgPlusVolume) {
    if (isVolumeCapitulation) factors.push(`extreme volume (${indicators.volumeRatio.toFixed(1)}x avg)`);
    if (fearGreed.value < 15) factors.push(`F&G extreme fear (${fearGreed.value})`);
    const confidence = isVolumeCapitulation ? 90 : 75;
    return { regime: MarketRegime.Capitulation, confidence, factors };
  }

  // --- Priority 2: Breakout ---
  const highVolume = indicators.volumeRatio > 1.5;
  const atrSpike = ctx?.prevAtr && ctx.prevAtr > 0
    ? indicators.atr / ctx.prevAtr > 1.5
    : false;
  const outsideBB = indicators.bollingerPercentB > 100 || indicators.bollingerPercentB < 0;

  if (highVolume && (atrSpike || outsideBB)) {
    factors.push(`high volume (${indicators.volumeRatio.toFixed(1)}x avg)`);
    if (atrSpike) factors.push(`ATR spike (${(indicators.atr / ctx!.prevAtr!).toFixed(1)}x prev)`);
    if (outsideBB) factors.push(`price outside BB (%B=${indicators.bollingerPercentB.toFixed(0)})`);
    const confidence = (atrSpike && outsideBB) ? 90 : 75;
    return { regime: MarketRegime.Breakout, confidence, factors };
  }

  // --- Priority 3: Bull Trend ---
  const emaBullish = indicators.ema20 > indicators.ema50;
  const strongAdx = indicators.adx > 25;
  const aboveVwap = currentPrice > indicators.vwap;

  if (emaBullish && strongAdx && aboveVwap) {
    factors.push(`EMA20 (${indicators.ema20.toFixed(1)}) > EMA50 (${indicators.ema50.toFixed(1)})`);
    factors.push(`ADX strong (${indicators.adx.toFixed(0)})`);
    factors.push(`price above VWAP (${currentPrice} > ${indicators.vwap.toFixed(1)})`);
    const confidence = Math.min(90, 60 + (indicators.adx - 25) * 2);
    return { regime: MarketRegime.BullTrend, confidence, factors };
  }

  // --- Priority 4: Bear Trend ---
  const emaBearish = indicators.ema20 < indicators.ema50;
  const belowVwap = currentPrice < indicators.vwap;

  if (emaBearish && strongAdx && belowVwap) {
    factors.push(`EMA20 (${indicators.ema20.toFixed(1)}) < EMA50 (${indicators.ema50.toFixed(1)})`);
    factors.push(`ADX strong (${indicators.adx.toFixed(0)})`);
    factors.push(`price below VWAP (${currentPrice} < ${indicators.vwap.toFixed(1)})`);
    const confidence = Math.min(90, 60 + (indicators.adx - 25) * 2);
    return { regime: MarketRegime.BearTrend, confidence, factors };
  }

  // --- Priority 4.5: Scalping (low volume dead zone) ---
  const isDeadZone = indicators.volumeRatio < 0.5 && indicators.adx < 25;
  if (isDeadZone) {
    factors.push(`dead zone: volume ${indicators.volumeRatio.toFixed(2)}x, ADX ${indicators.adx.toFixed(0)}`);
    const confidence = Math.round(50 + (0.5 - indicators.volumeRatio) * 40);
    return { regime: MarketRegime.Scalping, confidence: Math.min(confidence, 75), factors };
  }

  // --- Priority 5: Range ---
  const weakAdx = indicators.adx < 20;
  const narrowBB = indicators.bollingerBandwidth < 4;

  if (weakAdx && narrowBB) {
    factors.push(`ADX low (${indicators.adx.toFixed(0)})`);
    factors.push(`BB bandwidth narrow (${indicators.bollingerBandwidth.toFixed(1)}%)`);
    const confidence = Math.min(80, 50 + (20 - indicators.adx) * 2);
    return { regime: MarketRegime.Range, confidence, factors };
  }

  // --- Priority 6: Default — weak trend from EMA alignment, or Range ---
  if (emaBullish) {
    factors.push(`weak bullish EMA alignment (EMA20 > EMA50)`);
    factors.push(`ADX insufficient (${indicators.adx.toFixed(0)})`);
    return { regime: MarketRegime.BullTrend, confidence: 35, factors };
  }

  if (emaBearish) {
    factors.push(`weak bearish EMA alignment (EMA20 < EMA50)`);
    factors.push(`ADX insufficient (${indicators.adx.toFixed(0)})`);
    return { regime: MarketRegime.BearTrend, confidence: 35, factors };
  }

  // No clear direction
  factors.push('no clear trend or range signal');
  return { regime: MarketRegime.Range, confidence: 25, factors };
}
