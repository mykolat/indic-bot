export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;  // (upper-lower)/middle * 100
  percentB: number;   // (price-lower)/(upper-lower) * 100
}

export interface Indicators {
  rsi: number;
  ema20: number;
  ema50: number;
  atr: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerBandwidth: number;
  bollingerPercentB: number;
  volumeRatio: number;
  vwap: number;
}

export function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

export function computeEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export function computeATR(
  highs: number[], lows: number[], closes: number[], period = 14,
): number {
  if (highs.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

export function computeMACD(closes: number[], fast = 12, slow = 26, signal = 9): MACDResult {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = computeEMA(closes, fast);
  const ema26 = computeEMA(closes, slow);
  const macdLine = ema12 - ema26;
  const macdSeries: number[] = [];
  for (let i = slow + signal; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    macdSeries.push(computeEMA(slice, fast) - computeEMA(slice, slow));
  }
  const signalLine = computeEMA(macdSeries, signal);
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}

export function computeBollingerBands(closes: number[], period = 20, stdDev = 2): BollingerResult {
  if (closes.length < period) {
    const p = closes[closes.length - 1] ?? 0;
    return { upper: p, middle: p, lower: p, bandwidth: 0, percentB: 50 };
  }
  const slice = closes.slice(-period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + stdDev * sd;
  const lower = middle - stdDev * sd;
  const lastPrice = closes[closes.length - 1];
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
  const percentB = upper !== lower ? ((lastPrice - lower) / (upper - lower)) * 100 : 50;
  return { upper, middle, lower, bandwidth, percentB };
}

export function computeVolumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < 2) return 1;
  const avgSlice = volumes.slice(-period - 1, -1);
  const avg = avgSlice.reduce((s, v) => s + v, 0) / avgSlice.length;
  if (avg === 0) return 1;
  return volumes[volumes.length - 1] / avg;
}

export function computeVWAP(
  highs: number[], lows: number[], closes: number[], volumes: number[],
): number {
  if (highs.length === 0) return 0;
  let tpv = 0;
  let totalVol = 0;
  for (let i = 0; i < highs.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    tpv += typical * volumes[i];
    totalVol += volumes[i];
  }
  return totalVol > 0 ? tpv / totalVol : closes[closes.length - 1];
}

export function computeIndicators(
  closes: number[], highs: number[], lows: number[], volumes: number[] = [],
): Indicators {
  const rsi = computeRSI(closes);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const atr = computeATR(highs, lows, closes);
  const trend = ema20 > ema50 * 1.001 ? 'bullish' : ema20 < ema50 * 0.999 ? 'bearish' : 'neutral';
  const macdResult = computeMACD(closes);
  const bb = computeBollingerBands(closes);
  const volumeRatio = volumes.length > 0 ? computeVolumeRatio(volumes) : 1;
  const vwap = volumes.length > 0
    ? computeVWAP(highs, lows, closes, volumes)
    : closes[closes.length - 1];

  return {
    rsi, ema20, ema50, atr, trend,
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    bollingerUpper: bb.upper,
    bollingerMiddle: bb.middle,
    bollingerLower: bb.lower,
    bollingerBandwidth: bb.bandwidth,
    bollingerPercentB: bb.percentB,
    volumeRatio,
    vwap,
  };
}
