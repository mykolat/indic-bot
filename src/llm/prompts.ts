import type { MarketSnapshot } from '../binance/market-data.js';
import type { Indicators } from '../indicators/technical.js';
import { computeRSI } from '../indicators/technical.js';
import type { PortfolioState } from '../risk/manager.js';
import type { CryptoNews, FearGreedData } from '../news/types.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';
import type { TradeRecord } from '../memory/session.js';

export interface MacroAnalysis {
  macro_summary: string;
  risk_environment: 'risk_on' | 'risk_off' | 'neutral';
  crypto_correlation_signal: 'bullish' | 'bearish' | 'neutral';
  key_levels: string[];
  refreshed_at: string;
}

export function buildSystemPrompt(config: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
  pairs?: string[];
  minConfidence?: number;
  fearGreedLeverageCap?: number;
}): string {
  return `You are an aggressive crypto futures trader managing a LIVE account with real money.
Trading pairs: ${config.pairs?.join(', ') ?? 'BTCUSDT, ETHUSDT, SOLUSDT'}
Monitoring macro: Oil (WTI), DXY, S&P500, VIX, EUR/USD, Gold, BTC Dominance
Target: +${config.targetReturnPct}% returns.

You receive: technical indicators (1h + 4h), funding rate, open interest, Fear & Greed, news with age, macro analysis, portfolio with open positions, session P&L, recent trade history.

MULTI-TIMEFRAME CONFIRMATION:
- LONG: Only if 1h AND 4h trends align bullish (EMA20 > EMA50). If only 1h bullish but 4h bearish, HOLD or use minimal leverage (3-5x).
- SHORT: Only if 1h AND 4h trends align bearish. If only 1h bearish but 4h bullish, HOLD.
- 4h trend overrides 1h for direction. Use 1h for entry timing.

ENTRY RULES:
- Trend-following: LONG if EMA20 > EMA50 (both timeframes), SHORT if EMA20 < EMA50
- Momentum: RSI 40-65 for LONG, 35-60 for SHORT. Avoid entries with RSI > 70 or RSI < 30.
- Volume: Only enter if volume ratio > 1.0x (current above 20-period average). Volume < 0.8x = avoid.
- VWAP: LONG only if price above VWAP. SHORT only if price below VWAP.
- Bollinger: Avoid LONG if %B > 90% (overbought). Avoid SHORT if %B < 10% (oversold).

CONFLUENCE CHECKLIST:
- Entry requirements are now determined dynamically by the current Market Regime.
- We operate in "Shark Mode": aggressive in trends, highly protective in capitulation, scalping in ranges.

FUNDING & OI SIGNALS:
- Funding rate < -0.05%: Crowded shorts, lean LONG if technicals confirm
- Funding rate > +0.1%: Crowded longs, lean SHORT if technicals confirm
- Funding trend rising 3+ periods: Follow momentum
- OI up >10% with flat price: Leverage buildup, risk of liquidation wick — reduce size

MARKET SENTIMENT (Fear & Greed):
- The Fear & Greed index is pre-processed by the Regime Classifier.
- In capitulation (<15), entry thresholds are stripped down but leverage is heavily capped.

POSITION MANAGEMENT:
- Exit rule 1: P&L < -${config.maxStopLossPct / 2}% and held > 4h with no recovery → CLOSE
- Exit rule 2: RSI > 78 on LONG → CLOSE. RSI < 22 on SHORT → CLOSE.
- Exit rule 3: Position held > 8h with P&L between -1% and +1% (stale) → CLOSE
- Exit rule 4: MACD histogram flipped against position direction → tighten exit
- After 2 consecutive losses on same pair: Skip next signal on that pair

RISK SCALING (enforced by system, your awareness helps):
- If session P&L < -5%: System halves max leverage and position size
- If session P&L < -10%: System caps leverage at 5x, position size at 25%
- Extreme Fear/Greed: System caps leverage at ${config.fearGreedLeverageCap ?? 10}x
- If confidence < ${config.minConfidence ?? 55}: System will reject your trade

CONSTRAINTS:
- Max leverage: ${config.maxLeverage}x
- Max position size: ${config.maxPositionPct}% of balance per trade
- Stop-loss MANDATORY (1-${config.maxStopLossPct}%)
- Minimum take-profit: ${config.minTakeProfitPct}%
- This is LIVE money. Be selective.
- Do NOT scalp. Target swing moves.

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
      "regime_override": "<optional: string if you disagree with the detected regime, e.g. 'capitulation'>",
      "reasoning": "<2-3 sentences: what signals aligned, what's the thesis>",
      "confidence": <1-100>
    }
  ],
  "next_check_minutes": <1-30>
}

next_check_minutes guide: How soon to re-analyze. Consider:
- Open positions → 1-2 min (monitor SL/TP, exits)
- High volume (>1x) + strong setup forming → 1-3 min
- Normal market, no positions → 5-10 min
- Low volume (<0.5x), all HOLD, no catalyst → 15-30 min
- Off-hours, dead tape → 20-30 min

confidence guide: <30 = very uncertain, 30-55 = weak, 55-70 = moderate, 70-85 = strong, >85 = very strong
Always include a decision for every pair. HOLD = do nothing.
If you need fresher news: { "pair": "_meta", "action": "FETCH_NEWS", ... }`;
}

// Backward-compatible constant for tests
export const SYSTEM_PROMPT = buildSystemPrompt({
  targetReturnPct: 100, minTakeProfitPct: 5,
  maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5,
});

export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
  indicators4h?: Map<string, Indicators>;
  portfolio: PortfolioState;
  signals: TradingViewSignal[];
  news: CryptoNews[];
  fearGreed: FearGreedData;
  sessionNotes?: string;
  recentTrades?: TradeRecord[];
  newsAnalysis?: import('../news/news-cache.js').NewsAnalysis;
  recentNewsWithAge?: Array<CryptoNews & { age_hours: number }>;
  macroAnalysis?: MacroAnalysis;
  sessionPnlPct?: number;
  lastOrderResult?: string;
  riskStatus?: string;  // 'normal' | 'reduced' | 'critical'
  staticSoul?: string;
  memoryContent?: string;
  regime?: string;
  layer1Reports?: import('./agents.js').Layer1Outputs;
  filterWarning?: string;
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

function getTradingSession(utcHour: number): string {
  if (utcHour >= 13 && utcHour < 16) return 'EU/US overlap (high liquidity)';
  if (utcHour >= 7 && utcHour < 8) return 'Asia close / EU open overlap';
  if (utcHour >= 0 && utcHour < 8) return 'Asia session';
  if (utcHour >= 7 && utcHour < 16) return 'European session';
  if (utcHour >= 13 && utcHour < 22) return 'US session';
  return 'Off-hours (low liquidity)';
}

function formatCurrentTime(): string {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = days[now.getUTCDay()];
  const h = now.getUTCHours().toString().padStart(2, '0');
  const m = now.getUTCMinutes().toString().padStart(2, '0');
  const session = getTradingSession(now.getUTCHours());
  return `${now.toISOString().slice(0, 10)} ${h}:${m} UTC (${day}) — ${session}`;
}

function buildEnrichedPrompt(data: EnrichedPromptData): string {
  let prompt = `## Context\nCurrent time: ${formatCurrentTime()}\n`;

  // Session status
  if (data.sessionPnlPct !== undefined) {
    const sign = data.sessionPnlPct >= 0 ? '+' : '';
    let riskLabel = 'NORMAL';
    if (data.riskStatus === 'critical') riskLabel = 'CRITICAL — leverage heavily reduced';
    else if (data.riskStatus === 'reduced') riskLabel = 'REDUCED — leverage halved';
    prompt += `Session P&L: ${sign}${data.sessionPnlPct.toFixed(2)}% | Risk status: ${riskLabel}\n`;
  }
  if (data.lastOrderResult) {
    prompt += `Last order: ${data.lastOrderResult}\n`;
  }
  prompt += '\n';

  if (data.regime) {
    prompt += `## Market Regime Persona & Override\n`;
    if (data.regime === 'bull_trend') prompt += '>>> REGIME: Bull Trend. You are an aggressive trend-follower. Hold winners longer. Ignore minor bearish divergences.\n\n';
    else if (data.regime === 'bear_trend') prompt += '>>> REGIME: Bear Trend. You are an aggressive trend-follower in a bear market. Press shorts. Ignore minor bullish divergences.\n\n';
    else if (data.regime === 'range') prompt += '>>> REGIME: Range. You are a cautious market-maker. Buy support, sell resistance. Take quick scalps. Tighten TP.\n\n';
    else if (data.regime === 'capitulation') prompt += '>>> REGIME: Capitulation. You are in extreme caution mode. Look for high-volume climax bottoms. Prioritize capital preservation.\n\n';
    else if (data.regime === 'breakout') prompt += '>>> REGIME: Breakout. Price is expanding rapidly. Trade momentum in direction of the break. Wider stops.\n\n';
    else prompt += '>>> REGIME: Unknown. Standard aggressive crypto futures trader.\n\n';
    prompt += `NOTE: If your narrative reading strongly contradicts this regime, use the 'regime_override' field to change it.\n\n`;
  }

  // Soul — static identity
  if (data.staticSoul) {
    prompt += `## Original System Soul\n${data.staticSoul}\n\n`;
  }

  // Memory — dynamic reflections
  if (data.memoryContent) {
    prompt += `## Dynamic Memory (Current Reflections)\n${data.memoryContent}\n\n`;
  }

  // Layer 1 Experts Distillation
  if (data.layer1Reports) {
    prompt += `## Expert Analysis Reports\n`;
    prompt += `News Expert:\n${data.layer1Reports.newsReport}\n\n`;
    prompt += `Macro Expert:\n${data.layer1Reports.macroReport}\n\n`;
    prompt += `Memory Expert:\n${data.layer1Reports.memoryReport}\n\n`;
  }

  if (data.filterWarning) {
    prompt += `\n>>> ⚠️ SHARK MODE WARNING ⚠️ <<<\n`;
    prompt += `System technical filters FAILED: ${data.filterWarning}\n`;
    prompt += `ACTION REQUIRED: You are heavily advised to HOLD. ONLY execute LONG/SHORT if you have EXTREME CONVICTION from news/fundamentals that overrides this technical weakness.\n\n`;
  }

  prompt += `## Technical Analysis\n\n`;

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

      // Volume narrative
      if (ind.volumeRatio > 1.8) {
        prompt += `!! HIGH VOLUME: ${ind.volumeRatio.toFixed(1)}x average — strong conviction\n`;
      } else if (ind.volumeRatio < 0.7) {
        prompt += `!! LOW VOLUME: ${ind.volumeRatio.toFixed(1)}x average — low conviction, weak move\n`;
      }

      // VWAP positioning
      if (ind.vwap) {
        const vwapDelta = ((currentPrice - ind.vwap) / ind.vwap * 100);
        const vwapSide = vwapDelta > 0 ? 'above' : 'below';
        const vwapBias = vwapDelta > 0 ? 'bullish' : 'bearish';
        prompt += `VWAP: price ${Math.abs(vwapDelta).toFixed(2)}% ${vwapSide} — ${vwapBias} intraday bias\n`;
      }

      // Bollinger Band alerts
      if (ind.bollingerPercentB > 90) {
        prompt += `!! AT UPPER BAND (%B=${ind.bollingerPercentB.toFixed(0)}%) — overbought, reversal risk\n`;
      } else if (ind.bollingerPercentB < 10) {
        prompt += `!! AT LOWER BAND (%B=${ind.bollingerPercentB.toFixed(0)}%) — oversold, bounce potential\n`;
      }
    }

    // 4h indicators
    const ind4h = data.indicators4h?.get(snap.pair);
    if (ind4h) {
      prompt += `4h Trend: ${ind4h.trend} | RSI(14) 4h: ${ind4h.rsi.toFixed(1)} | EMA20 4h: $${ind4h.ema20.toFixed(2)} | ATR 4h: $${ind4h.atr.toFixed(2)}\n`;
    }

    // 15m RSI
    if (snap.candles15m && snap.candles15m.length > 15) {
      const closes15m = snap.candles15m.map(c => parseFloat(c.close));
      const rsi15m = computeRSI(closes15m);
      prompt += `RSI(14) 15m: ${rsi15m.toFixed(1)}\n`;
    }

    // Funding history
    if (snap.fundingHistory && snap.fundingHistory.length > 0) {
      const avg = snap.fundingHistory.reduce((s, f) => s + f.rate, 0) / snap.fundingHistory.length;
      const trend = snap.fundingHistory.length >= 2
        ? (snap.fundingHistory[snap.fundingHistory.length - 1].rate > snap.fundingHistory[0].rate ? '↑' : '↓')
        : '→';
      prompt += `Funding history (${snap.fundingHistory.length} periods): avg=${(avg * 100).toFixed(4)}% trend=${trend}\n`;

      // Funding trend narrative
      if (snap.fundingHistory.length >= 3) {
        const rates = snap.fundingHistory.map(f => f.rate);
        const first = rates[0];
        const last = rates[rates.length - 1];
        const fundingTrend = last > first ? 'RISING' : last < first ? 'FALLING' : 'STABLE';
        prompt += `Funding trend: ${fundingTrend} (${(first * 100).toFixed(4)}% → ${(last * 100).toFixed(4)}%)\n`;
        if (last < -0.0005) prompt += `!! NEGATIVE FUNDING: crowded shorts, potential squeeze\n`;
        if (last > 0.001) prompt += `!! HIGH FUNDING: crowded longs, potential dump\n`;
      }
    }

    // L/S ratio
    if (snap.longShortRatio !== null && snap.longShortRatio !== undefined) {
      const lsLabel = snap.longShortRatio > 1.5 ? ' (crowded longs ⚠)' :
        snap.longShortRatio < 0.7 ? ' (crowded shorts ⚠)' : '';
      prompt += `L/S ratio: ${snap.longShortRatio.toFixed(2)}${lsLabel}\n`;
    }

    // Order book / Liquidity Profile
    const liq = snap.liquidityProfile;
    if (liq) {
      const imbVal = `${liq.imbalancePct >= 0 ? '+' : ''}${liq.imbalancePct.toFixed(1)}%`;
      prompt += `Order book (+/- 2% depth): Bids ${liq.buyVolume.toFixed(2)} | Asks ${liq.sellVolume.toFixed(2)} | Imbalance: ${imbVal}\n`;
      if (liq.supportLevel) prompt += `Strongest Support Wall: $${liq.supportLevel}\n`;
      if (liq.resistanceLevel) prompt += `Strongest Resistance Wall: $${liq.resistanceLevel}\n`;
      if (liq.imbalancePct > 20) prompt += `!! HEAVY BID SUPPORT — ${imbVal} imbalance\n`;
      if (liq.imbalancePct < -20) prompt += `!! HEAVY ASK RESISTANCE — ${imbVal} imbalance\n`;
    } else {
      prompt += `Order book depth: ${snap.orderBookBidPct.toFixed(0)}% bids / ${snap.orderBookAskPct.toFixed(0)}% asks\n`;
    }

    const oiDelta = snap.openInterestDelta;
    const oiDeltaStr = oiDelta !== undefined && oiDelta !== 0
      ? ` (${oiDelta >= 0 ? '+' : ''}${oiDelta.toFixed(1)}% vs prev)` : '';
    prompt += `Funding: ${snap.fundingRate} | OI: ${snap.openInterest}${oiDeltaStr}\n`;

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

  // Macro markets
  if (data.macroAnalysis) {
    const m = data.macroAnalysis;
    const ageH = Math.round((Date.now() - new Date(m.refreshed_at).getTime()) / 3_600_000);
    prompt += `## Macro Markets (refreshed ${ageH}h ago)\n`;
    prompt += `Environment: ${m.risk_environment.toUpperCase()} | Crypto signal: ${m.crypto_correlation_signal.toUpperCase()}\n`;
    prompt += `${m.macro_summary}\n`;
    if (m.key_levels.length > 0) {
      prompt += `Key levels: ${m.key_levels.join(' | ')}\n`;
    }
    prompt += '\n';
  }

  // News section
  if (data.recentNewsWithAge && data.recentNewsWithAge.length > 0) {
    prompt += '## News (last 48h)\n';
    if (data.newsAnalysis) {
      const na = data.newsAnalysis;
      prompt += `Sentiment: ${na.overall_sentiment} | fed=${na.macro_signals.fed_stance}, risk=${na.macro_signals.risk_appetite}\n`;
      prompt += `Summary: ${na.market_summary}\n`;
      if (na.top_signals.length > 0) {
        prompt += 'Key signals:\n';
        for (const s of na.top_signals.sort((a, b) => b.importance - a.importance).slice(0, 10)) {
          const coins = s.coins.join('/');
          prompt += `  [${s.importance}/10] ${coins} ${s.direction.toUpperCase()} (${s.timeframe}) — ${s.catalyst}\n`;
        }
      }
      if (na.risk_events.length > 0) {
        prompt += `Risk: ${na.risk_events.slice(0, 3).join(' | ')}\n`;
      }
    }
    prompt += '\nHeadlines:\n';
    for (const n of data.recentNewsWithAge.slice(0, 30)) {
      const age = Math.round(n.age_hours);
      const coins = n.coins.length > 0 ? `[${n.coins.join('/')}] ` : '';
      const sent = n.sentiment > 0 ? '▲' : n.sentiment < 0 ? '▼' : '─';
      prompt += `  [${age}h ago] ${coins}${sent} ${n.title}\n`;
    }
    prompt += '\n';
  } else if (data.newsAnalysis) {
    const na = data.newsAnalysis;
    prompt += '## News Analysis\n';
    prompt += `Sentiment: ${na.overall_sentiment} | fed=${na.macro_signals.fed_stance}, risk=${na.macro_signals.risk_appetite}\n`;
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
    prompt += '## Recent News\n';
    for (const n of data.news) {
      const sentimentStr = n.sentiment > 0 ? `+${n.sentiment}` : `${n.sentiment}`;
      const coins = n.coins.length > 0 ? ` (${n.coins.join(', ')})` : '';
      prompt += `- [${sentimentStr}] "${n.title}"${coins} — ${n.date} via ${n.source}\n`;
    }
    prompt += '\n';
  }

  // Trade performance analysis
  if (data.recentTrades && data.recentTrades.length > 0) {
    const wins = data.recentTrades.filter(t => t.pnlUsd >= 0);
    const losses = data.recentTrades.filter(t => t.pnlUsd < 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnlUsd), 0) / losses.length : 0;

    prompt += '## Trade Performance\n';
    prompt += `Last ${data.recentTrades.length} trades: ${wins.length}W-${losses.length}L`;
    if (wins.length > 0 || losses.length > 0) {
      prompt += ` | Avg win: $${avgWin.toFixed(2)}, Avg loss: $${avgLoss.toFixed(2)}`;
    }
    prompt += '\n';

    // Streak detection
    let streak = 0;
    let streakType = '';
    for (const t of data.recentTrades) {
      if (streak === 0) { streakType = t.pnlUsd >= 0 ? 'W' : 'L'; streak = 1; }
      else if ((t.pnlUsd >= 0 ? 'W' : 'L') === streakType) streak++;
      else break;
    }
    if (streak >= 2 && streakType === 'L') {
      prompt += `!! LOSING STREAK: ${streak} consecutive losses — reduce size, be more selective\n`;
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

export type SwarmPersona = 'permabull' | 'permabear' | 'paranoid_risk_manager';

export function buildSwarmPersonaPrompt(persona: SwarmPersona, config?: Parameters<typeof buildSystemPrompt>[0]): string {
  const basePrompt = buildSystemPrompt(config || {
    targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5
  });

  let personaPrefix = '';
  switch (persona) {
    case 'permabull':
      personaPrefix = `>>> SWARM PERSONA: You are an ultra-aggressive PERMABULL. You look for any excuse to go LONG. You ignore bearish signals unless absolutely catastrophic. <<<\n\n`;
      break;
    case 'permabear':
      personaPrefix = `>>> SWARM PERSONA: You are an ultra-aggressive PERMABEAR. You look for any excuse to go SHORT. You ignore bullish signals unless absolutely undeniable. <<<\n\n`;
      break;
    case 'paranoid_risk_manager':
      personaPrefix = `>>> SWARM PERSONA: You are a PARANOID RISK MANAGER. Your only goal is capital preservation. You look for any excuse to HOLD or CLOSE. You only approve entries if the setup is mathematically flawless. <<<\n\n`;
      break;
  }

  return personaPrefix + basePrompt;
}

export function buildConsensusPrompt(expertDecisions: string[], config?: Parameters<typeof buildSystemPrompt>[0]): string {
  const basePrompt = buildSystemPrompt(config || {
    targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5
  });

  // We replace the persona intro with the judge persona
  const judgePrompt = basePrompt.replace(
    /You are an aggressive crypto futures trader managing a LIVE account with real money\./,
    `You are the SWARM CONSENSUS JUDGE managing a LIVE account with real money. You must objectively weigh the conflicting opinions of your sub-agents and make the final, most rational decision.`
  );

  let prompt = `${judgePrompt}\n\n## Sub-Agent Opinions for Current Cycle\n\n`;
  expertDecisions.forEach((dec, i) => {
    prompt += `### Expert ${i + 1}\n${dec}\n\n`;
  });

  prompt += `Analyze the expert opinions. If they strongly disagree, lean towards HOLD. If two agree, lean towards their consensus if rationally justified.\n`;
  return prompt;
}
