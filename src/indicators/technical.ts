export interface Indicators {
  rsi: number;
  ema20: number;
  ema50: number;
  atr: number;
  trend: 'bullish' | 'bearish' | 'neutral';
}

export function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50; // neutral fallback

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
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
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number {
  if (highs.length < 2) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trueRanges.push(tr);
  }

  const slice = trueRanges.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

export function computeIndicators(
  closes: number[],
  highs: number[],
  lows: number[],
): Indicators {
  const rsi = computeRSI(closes);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const atr = computeATR(highs, lows, closes);
  const trend = ema20 > ema50 * 1.001 ? 'bullish' : ema20 < ema50 * 0.999 ? 'bearish' : 'neutral';

  return { rsi, ema20, ema50, atr, trend };
}
