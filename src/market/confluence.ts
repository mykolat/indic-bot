export interface ConfluenceInput {
  trend: 'bullish' | 'bearish' | 'neutral';
  volumeRatio: number;
  vwap: number;
  markPrice: number;
  rsi: number;
  rsiRange: [number, number];
  hasNewsCatalyst: boolean;
}

export interface ConfluenceResult {
  score: number;
  factors: string[];
}

export function computeConfluence(input: ConfluenceInput): ConfluenceResult {
  const factors: string[] = [];

  // 1. Trend alignment (EMA20 vs EMA50)
  if (input.trend === 'bullish' || input.trend === 'bearish') {
    factors.push('trend');
  }

  // 2. Volume above average
  if (input.volumeRatio > 1) {
    factors.push('volume');
  }

  // 3. VWAP alignment with trend
  if (input.trend === 'bullish' && input.markPrice > input.vwap) {
    factors.push('vwap');
  } else if (input.trend === 'bearish' && input.markPrice < input.vwap) {
    factors.push('vwap');
  }

  // 4. RSI in acceptable range for current regime
  if (input.rsi >= input.rsiRange[0] && input.rsi <= input.rsiRange[1]) {
    factors.push('rsi');
  }

  // 5. News/macro catalyst present
  if (input.hasNewsCatalyst) {
    factors.push('news');
  }

  return { score: factors.length, factors };
}
