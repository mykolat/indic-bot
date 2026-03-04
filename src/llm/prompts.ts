import type { MarketSnapshot } from '../binance/market-data.js';
import type { PortfolioState } from '../risk/manager.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';

export const SYSTEM_PROMPT = `You are an expert crypto futures trader analyzing market data to make trading decisions.

You will receive:
- OHLCV candle data (1h and 4h timeframes) for multiple pairs
- Funding rate and open interest data
- Current portfolio state (balance, open positions)
- Optional TradingView indicator signals

Respond ONLY with valid JSON in this exact format:
{
  "decisions": [
    {
      "pair": "BTCUSDT",
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
      "size_pct": <0-33, percentage of balance to use>,
      "leverage": <1-10>,
      "stop_loss_pct": <1-3, mandatory for LONG/SHORT>,
      "take_profit_pct": <1-10>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Rules:
- Always include a decision for each pair provided
- HOLD means do nothing for that pair
- CLOSE means close existing position
- Max leverage: 10x
- Stop-loss is MANDATORY for LONG and SHORT (1-3%)
- Be conservative — only trade when there's a clear signal
- Consider funding rate: very high positive = shorts being squeezed, very negative = longs being squeezed
- Consider open interest changes for momentum confirmation`;

export function buildUserPrompt(
  snapshots: MarketSnapshot[],
  portfolio: PortfolioState,
  signals: TradingViewSignal[],
): string {
  let prompt = '## Market Data\n\n';

  for (const snap of snapshots) {
    const lastCandle1h = snap.candles1h[snap.candles1h.length - 1];
    const lastCandle4h = snap.candles4h[snap.candles4h.length - 1];

    prompt += `### ${snap.pair}\n`;
    prompt += `Mark Price: ${snap.markPrice}\n`;
    prompt += `Funding Rate: ${snap.fundingRate}\n`;
    prompt += `Open Interest: ${snap.openInterest}\n`;
    prompt += `Last 1h candle: O=${lastCandle1h?.open} H=${lastCandle1h?.high} L=${lastCandle1h?.low} C=${lastCandle1h?.close} V=${lastCandle1h?.volume}\n`;
    prompt += `Last 4h candle: O=${lastCandle4h?.open} H=${lastCandle4h?.high} L=${lastCandle4h?.low} C=${lastCandle4h?.close} V=${lastCandle4h?.volume}\n`;

    const recentCloses1h = snap.candles1h.slice(-5).map(c => c.close).join(', ');
    prompt += `Recent 1h closes (last 5): ${recentCloses1h}\n\n`;
  }

  prompt += '## Portfolio\n';
  prompt += `Balance: $${portfolio.balanceUsd.toFixed(2)}\n`;
  prompt += `Session PnL: $${portfolio.sessionPnl.toFixed(2)}\n`;

  if (portfolio.positions.length > 0) {
    prompt += 'Open positions:\n';
    for (const pos of portfolio.positions) {
      prompt += `- ${pos.pair}: ${pos.side} $${pos.sizeUsd.toFixed(2)} @ ${pos.leverage}x\n`;
    }
  } else {
    prompt += 'No open positions.\n';
  }

  if (signals.length > 0) {
    prompt += '\n## TradingView Signals\n';
    for (const sig of signals) {
      prompt += `- ${sig.pair}: ${sig.signal} (${sig.indicator}=${sig.value}, ${sig.timeframe})\n`;
    }
  }

  prompt += '\nProvide your trading decisions as JSON:';
  return prompt;
}
