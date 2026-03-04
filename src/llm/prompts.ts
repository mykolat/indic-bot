import type { MarketSnapshot } from '../binance/market-data.js';
import type { Indicators } from '../indicators/technical.js';
import type { PortfolioState } from '../risk/manager.js';
import type { CryptoNews, FearGreedData } from '../news/types.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';
import type { TradeRecord } from '../memory/session.js';

export function buildSystemPrompt(config: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
}): string {
  return `You are an aggressive crypto futures trader. Target: +${config.targetReturnPct}% returns.

You receive: technical indicators, candles, funding rate, open interest, Fear & Greed, news, portfolio with open positions (entry price + P&L).

STRATEGY RULES (you may override with explicit reasoning):
- Trend-following: LONG if EMA20 > EMA50, SHORT if EMA20 < EMA50
- Momentum entry: RSI 40-65 for LONG entries, 35-60 for SHORT entries
- Funding arbitrage: extreme negative funding → crowded shorts → lean LONG
- Exit rule 1: position P&L < -${config.maxStopLossPct / 2}% and held > 4h with no progress → CLOSE
- Exit rule 2: RSI > 78 on active LONG → consider CLOSE; RSI < 22 on active SHORT → consider CLOSE
- Do NOT scalp. Minimum take-profit: ${config.minTakeProfitPct}%. Target swing moves.

CONSTRAINTS:
- Max leverage: ${config.maxLeverage}x
- Max position size: ${config.maxPositionPct}% of balance per trade
- Stop-loss MANDATORY for LONG/SHORT (1-${config.maxStopLossPct}%)
- This is a TESTNET account. Be aggressive. Take positions when you see a setup.

Respond ONLY with valid JSON:
{
  "decisions": [
    {
      "pair": "BTCUSDT",
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
      "size_pct": <0-${config.maxPositionPct}>,
      "leverage": <1-${config.maxLeverage}>,
      "stop_loss_pct": <1-${config.maxStopLossPct}>,
      "take_profit_pct": <${config.minTakeProfitPct}-50>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Always include a decision for every pair. HOLD = do nothing. CLOSE = close existing position.
If you need fresher news data, add one extra decision: { "pair": "_meta", "action": "FETCH_NEWS", "size_pct": 0, "leverage": 0, "stop_loss_pct": 0, "take_profit_pct": 0, "reasoning": "<why you need fresh news>" }`;
}

// Backward-compatible constant for tests
export const SYSTEM_PROMPT = buildSystemPrompt({
  targetReturnPct: 100, minTakeProfitPct: 5,
  maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5,
});

export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
  portfolio: PortfolioState;
  signals: TradingViewSignal[];
  news: CryptoNews[];
  fearGreed: FearGreedData;
  sessionNotes?: string;
  recentTrades?: TradeRecord[];
  newsAnalysis?: import('../news/news-cache.js').NewsAnalysis;
}

export function buildUserPrompt(data: EnrichedPromptData): string;
export function buildUserPrompt(
  snapshots: MarketSnapshot[],
  portfolio: PortfolioState,
  signals: TradingViewSignal[],
): string;
export function buildUserPrompt(
  dataOrSnapshots: EnrichedPromptData | MarketSnapshot[],
  portfolio?: PortfolioState,
  signals?: TradingViewSignal[],
): string {
  // Enriched path
  if (!Array.isArray(dataOrSnapshots)) {
    return buildEnrichedPrompt(dataOrSnapshots);
  }

  // Legacy path (for backward compatibility with tests)
  return buildEnrichedPrompt({
    snapshots: dataOrSnapshots,
    indicators: new Map(),
    portfolio: portfolio!,
    signals: signals || [],
    news: [],
    fearGreed: { value: 50, label: 'Neutral' },
  });
}

function buildEnrichedPrompt(data: EnrichedPromptData): string {
  let prompt = '## Technical Analysis\n\n';

  for (const snap of data.snapshots) {
    const ind = data.indicators.get(snap.pair);
    const lastCandle1h = snap.candles1h[snap.candles1h.length - 1];
    const price24hAgo = snap.candles1h.length >= 24
      ? parseFloat(snap.candles1h[snap.candles1h.length - 24].close)
      : null;
    const currentPrice = parseFloat(snap.markPrice);
    const change24h = price24hAgo ? ((currentPrice - price24hAgo) / price24hAgo * 100).toFixed(1) : 'N/A';

    prompt += `### ${snap.pair}\n`;
    prompt += `Price: $${currentPrice} | 24h: ${change24h}%\n`;

    if (ind) {
      prompt += `RSI(14): ${ind.rsi.toFixed(1)} | EMA20: $${ind.ema20.toFixed(2)} | EMA50: $${ind.ema50.toFixed(2)} | ATR: $${ind.atr.toFixed(2)}\n`;
      prompt += `Trend: ${ind.trend} | VWAP: $${ind.vwap.toFixed(2)} | Vol ratio: ${ind.volumeRatio.toFixed(2)}x\n`;
      prompt += `MACD: ${ind.macd.toFixed(4)} | Signal: ${ind.macdSignal.toFixed(4)} | Hist: ${ind.macdHistogram >= 0 ? '+' : ''}${ind.macdHistogram.toFixed(4)}\n`;
      prompt += `Bollinger: L=$${ind.bollingerLower.toFixed(2)} M=$${ind.bollingerMiddle.toFixed(2)} U=$${ind.bollingerUpper.toFixed(2)} | %B: ${ind.bollingerPercentB.toFixed(0)}% | BW: ${ind.bollingerBandwidth.toFixed(1)}%\n`;
    }

    prompt += `Funding: ${snap.fundingRate} | OI: ${snap.openInterest}\n`;

    const recentCloses = snap.candles1h.slice(-10).map(c => c.close).join(', ');
    prompt += `Recent 1h closes: ${recentCloses}\n`;

    if (lastCandle1h) {
      prompt += `Last 1h: O=${lastCandle1h.open} H=${lastCandle1h.high} L=${lastCandle1h.low} C=${lastCandle1h.close} V=${lastCandle1h.volume}\n`;
    }
    prompt += '\n';
  }

  // Sentiment
  prompt += '## Market Sentiment\n';
  prompt += `Fear & Greed: ${data.fearGreed.value} (${data.fearGreed.label})\n\n`;

  // News
  if (data.newsAnalysis) {
    const na = data.newsAnalysis;
    prompt += '## News Analysis\n';
    prompt += `Sentiment: ${na.overall_sentiment} | Macro: fed=${na.macro_signals.fed_stance}, risk=${na.macro_signals.risk_appetite}\n`;
    prompt += `Summary: ${na.market_summary}\n`;
    if (na.top_signals.length > 0) {
      prompt += 'Signals:\n';
      for (const s of na.top_signals.sort((a, b) => b.importance - a.importance).slice(0, 8)) {
        const coins = s.coins.join('/');
        prompt += `  [${s.importance}/10] ${coins} ${s.direction.toUpperCase()} (${s.timeframe}) — ${s.catalyst}${s.conflicting ? ' ⚡conflicting' : ''}\n`;
      }
    }
    if (na.risk_events.length > 0) {
      prompt += `Risk events: ${na.risk_events.join(', ')}\n`;
    }
    prompt += '\n';
  } else if (data.news.length > 0) {
    // Fallback to raw headlines if no analysis yet
    prompt += '## Recent News\n';
    for (const n of data.news) {
      const sentimentStr = n.sentiment > 0 ? `+${n.sentiment}` : `${n.sentiment}`;
      const coins = n.coins.length > 0 ? ` (${n.coins.join(', ')})` : '';
      prompt += `- [${sentimentStr}] "${n.title}"${coins} — ${n.date} via ${n.source}\n`;
    }
    prompt += '\n';
  }

  // Portfolio
  prompt += '## Portfolio\n';
  prompt += `Balance: $${data.portfolio.balanceUsd.toFixed(2)}\n`;
  prompt += `Session PnL: $${data.portfolio.sessionPnl.toFixed(2)}\n`;

  if (data.portfolio.positions.length > 0) {
    prompt += 'Open positions:\n';
    for (const pos of data.portfolio.positions) {
      const pnlSign = pos.unrealizedPnlPct >= 0 ? '+' : '';
      prompt += `  ${pos.pair} ${pos.side} | entry $${pos.entryPrice.toFixed(2)} | held ${pos.heldHours.toFixed(1)}h | P&L: ${pnlSign}${pos.unrealizedPnlPct.toFixed(1)}% | ${pos.leverage}x leverage\n`;
    }
  } else {
    prompt += 'No open positions.\n';
  }

  // TradingView signals
  if (data.signals.length > 0) {
    prompt += '\n## TradingView Signals\n';
    for (const sig of data.signals) {
      prompt += `- ${sig.pair}: ${sig.signal} (${sig.indicator}=${sig.value}, ${sig.timeframe})\n`;
    }
  }

  if (data.sessionNotes) {
    prompt += '\n## Session Memory\n';
    prompt += data.sessionNotes + '\n';
  }

  if (data.recentTrades && data.recentTrades.length > 0) {
    prompt += '\n## Recent Closed Trades\n';
    for (const t of data.recentTrades.slice(0, 5)) {
      const sign = t.pnlUsd >= 0 ? '+' : '';
      prompt += `- ${t.pair} ${t.action}: ${sign}$${t.pnlUsd.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%) closed ${t.closedAt}\n`;
    }
  }

  prompt += '\nProvide your trading decisions as JSON:';
  return prompt;
}
