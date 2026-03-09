import { computeAllowedSlRange } from './sl-tightening-rules.js';

export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
  confidence?: number;
  setup_detected?: boolean;
  setup_type?: string;
  directional_bias?: 'long' | 'short' | 'neutral';
  entry_valid_now?: boolean;
  invalidators?: string[];
  risk_flags?: string[];
  data_gaps?: string[];
  abstain_reason?: string | null;
  session_context?: {
    session_pattern_active: boolean;
    session_fit_score: number;
    session_role: 'supports' | 'neutral' | 'contradicts';
    session_reason: string;
  };
}

export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;        // from Binance p.entryPrice
  unrealizedPnlPct: number;  // signed % of margin (e.g. -2.4 or +8.1)
  heldHours: number;         // hours since position opened
  marginUsd?: number;        // notional / leverage
  unrealizedPnlUsd?: number; // raw unrealized profit in USD
}

export interface PortfolioState {
  balanceUsd: number;      // walletBalance (total, incl. margin locked)
  availableUsd: number;    // availableBalance (free to use)
  positions: Position[];
  sessionPnl: number;
  drawdownPct: number;
  marginBalanceUsd?: number;
  totalUnrealizedPnlUsd?: number;
  bnbBalance?: number;
  totalAccountValueUsd?: number;
}

export interface ValidationResult {
  approved: boolean;
  reason?: string;
  shutdown?: boolean;
  marginShortfall?: {
    neededMargin: number;
    availableMargin: number;
    shortfall: number;
  };
}

interface RiskConfig {
  minLeverage?: number;
  maxLeverage: number;
  minPositionPct?: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxStopLossPct: number;
  maxDrawdownPct: number;
  maxLossUsd: number;
  maxLossPct: number;  // % of balance; overrides maxLossUsd if > 0
  minConfidence?: number;  // reject decisions below this confidence (default 55)
  maxDailyLossPct?: number;  // % of balance — daily loss limit (survives restart)
}

export interface RiskExtraContext {
  dailyRealizedPnl?: number;
  spreadPct?: number;
  medianSpreadPct?: number;
  spreadSampleSize?: number;
}

export interface ValidationContext {
  indicators4h?: Map<string, { trend: string }>;
  indicators1h?: Map<string, { atr: number; trend: string }>;
  fearGreed?: { value: number };
  fearGreedLeverageCap?: number;
  regimeMinConfidence?: number;  // from FilterProfile, overrides global
}

export interface DecisionEnvelope {
  maxLeverage: number;
  recommendedLeverage: [number, number];
  maxSizePct: number;
  recommendedSizePct: [number, number];
  minConfidence: number;
  blockedPairs: string[];
  constraints: string[];
}

export interface EnvelopeContext {
  fearGreed?: { value: number };
  fearGreedLeverageCap?: number;
  isWeekend?: boolean;
  weekendLeverageMultiplier?: number;
  regimeLeverageMultiplier?: number;
}

export interface AdjustContext {
  currentSlPrice: number;
  currentTpPrice: number;
  entryPrice: number;
  side: 'LONG' | 'SHORT';
}

export const BETA_TO_BTC: Record<string, number> = {
  BTCUSDT: 1.0, ETHUSDT: 1.3, SOLUSDT: 1.8,
  BNBUSDT: 1.1, XRPUSDT: 1.5, DOGEUSDT: 2.0,
  ADAUSDT: 1.5, AVAXUSDT: 1.7, LINKUSDT: 1.4,
  NEARUSDT: 1.6, SUIUSDT: 1.9, PEPEUSDT: 2.5,
  LTCUSDT: 1.2, APTUSDT: 1.7,
};

export class RiskManager {
  constructor(private config: RiskConfig) { }

  validate(decision: TradeDecision, portfolio: PortfolioState, ctx?: ValidationContext, adjustCtx?: AdjustContext, extra?: RiskExtraContext): ValidationResult {
    if (decision.action === 'HOLD' || decision.action === 'CLOSE' || decision.action === 'FETCH_NEWS') {
      return { approved: true };
    }

    if (decision.action === 'ADJUST') {
      if (!adjustCtx) {
        return { approved: false, reason: 'ADJUST requires position context' };
      }
      const { currentSlPrice, entryPrice, side } = adjustCtx;
      // Calculate new SL price from pct
      // Positive stop_loss_pct = SL in loss zone, Negative = profit lock
      const newSlPrice = side === 'LONG'
        ? entryPrice * (1 - decision.stop_loss_pct / 100)
        : entryPrice * (1 + decision.stop_loss_pct / 100);

      // Ratchet: SL can only improve
      if (side === 'LONG' && newSlPrice < currentSlPrice) {
        return { approved: false, reason: `Ratchet violation: new SL $${newSlPrice.toFixed(4)} < current $${currentSlPrice.toFixed(4)}` };
      }
      if (side === 'SHORT' && newSlPrice > currentSlPrice) {
        return { approved: false, reason: `Ratchet violation: new SL $${newSlPrice.toFixed(4)} > current $${currentSlPrice.toFixed(4)}` };
      }

      // Tiered SL tightening: prevent premature profit-killing
      const pos = portfolio.positions.find(p => p.pair === decision.pair);
      if (pos && ctx?.indicators1h) {
        const ind1h = ctx.indicators1h.get(decision.pair);
        const markPrice = entryPrice * (1 + (side === 'LONG' ? 1 : -1) * pos.unrealizedPnlPct / 100);
        const atrPct = ind1h ? (ind1h.atr / markPrice) * 100 : 1.5;

        const range = computeAllowedSlRange({ side, entryPrice, currentPrice: markPrice, atrPct });

        if (side === 'LONG' && newSlPrice > range.maxSlPrice) {
          return { approved: false, reason: `SL too tight [${range.tier}]: max $${range.maxSlPrice.toFixed(4)}, requested $${newSlPrice.toFixed(4)}` };
        }
        if (side === 'SHORT' && newSlPrice < range.maxSlPrice) {
          return { approved: false, reason: `SL too tight [${range.tier}]: max $${range.maxSlPrice.toFixed(4)}, requested $${newSlPrice.toFixed(4)}` };
        }
      }

      return { approved: true };
    }

    // Confidence check — regime-specific overrides global
    {
      const confidence = decision.confidence ?? 50;
      const minConf = ctx?.regimeMinConfidence ?? this.config.minConfidence ?? 55;
      if (confidence < minConf) {
        return { approved: false, reason: `Low confidence: ${confidence} < ${minConf}` };
      }
    }

    const effectiveMaxLoss = this.config.maxLossPct > 0
      ? portfolio.balanceUsd * this.config.maxLossPct / 100
      : this.config.maxLossUsd;

    if (portfolio.sessionPnl <= -effectiveMaxLoss) {
      return { approved: false, reason: `Session loss exceeded max $${effectiveMaxLoss.toFixed(2)} — shutdown triggered`, shutdown: true };
    }

    // Daily loss limit (DB-backed, survives restart)
    if (this.config.maxDailyLossPct && this.config.maxDailyLossPct > 0 && extra?.dailyRealizedPnl != null) {
      const dailyLimit = portfolio.balanceUsd * this.config.maxDailyLossPct / 100;
      if (extra.dailyRealizedPnl <= -dailyLimit) {
        return { approved: false, reason: `Daily loss $${Math.abs(extra.dailyRealizedPnl).toFixed(2)} exceeded limit $${dailyLimit.toFixed(2)} (${this.config.maxDailyLossPct}%) — shutdown triggered`, shutdown: true };
      }
    }

    if (portfolio.drawdownPct >= this.config.maxDrawdownPct) {
      return { approved: false, reason: `Drawdown ${portfolio.drawdownPct.toFixed(1)}% exceeded max ${this.config.maxDrawdownPct}% — shutdown triggered`, shutdown: true };
    }

    const minLev = this.config.minLeverage ?? 1;
    if (decision.leverage < minLev) {
      console.log(`[Risk] Bumping leverage ${decision.leverage}x → ${minLev}x (min floor)`);
      decision.leverage = minLev;
    }

    if (decision.leverage > this.config.maxLeverage) {
      return { approved: false, reason: `leverage ${decision.leverage}x exceeds max ${this.config.maxLeverage}x` };
    }

    const minSize = this.config.minPositionPct ?? 0;
    if (minSize > 0 && decision.size_pct < minSize) {
      console.log(`[Risk] Bumping size_pct ${decision.size_pct}% → ${minSize}% (min floor)`);
      decision.size_pct = minSize;
    }

    if (decision.size_pct > this.config.maxPositionPct) {
      return { approved: false, reason: `position size ${decision.size_pct}% exceeds max ${this.config.maxPositionPct}%` };
    }

    if (!decision.stop_loss_pct || decision.stop_loss_pct <= 0) {
      return { approved: false, reason: 'stop-loss is mandatory' };
    }

    if (decision.stop_loss_pct > this.config.maxStopLossPct) {
      return { approved: false, reason: `stop-loss ${decision.stop_loss_pct}% exceeds max ${this.config.maxStopLossPct}%` };
    }

    // Beta-adjusted exposure — correlated liquidation protection
    const getBeta = (pair: string) => BETA_TO_BTC[pair] ?? 1.0;
    const directionSign = (side: 'LONG' | 'SHORT') => side === 'LONG' ? 1 : -1;

    let longExposure = 0;
    let shortExposure = 0;
    for (const p of portfolio.positions) {
      const margin = p.sizeUsd / p.leverage;
      const betaMargin = margin * getBeta(p.pair);
      if (p.side === 'LONG') longExposure += betaMargin;
      else shortExposure += betaMargin;
    }

    const newMargin = (decision.size_pct / 100) * portfolio.balanceUsd;

    // Hard check: enough free margin to actually place the order
    if (portfolio.availableUsd > 0 && newMargin > portfolio.availableUsd) {
      return {
        approved: false,
        reason: `margin needed $${newMargin.toFixed(2)} exceeds available $${portfolio.availableUsd.toFixed(2)}`,
        marginShortfall: {
          neededMargin: newMargin,
          availableMargin: portfolio.availableUsd,
          shortfall: newMargin - portfolio.availableUsd,
        },
      };
    }

    const newBetaMargin = newMargin * getBeta(decision.pair);
    if (decision.action === 'LONG') longExposure += newBetaMargin;
    else shortExposure += newBetaMargin;

    const netExposure = Math.abs(longExposure - shortExposure);
    const grossExposure = longExposure + shortExposure;
    const effectiveExposure = Math.max(netExposure, grossExposure * 0.5);
    const totalExposurePct = (effectiveExposure / portfolio.balanceUsd) * 100;

    if (totalExposurePct > this.config.maxExposurePct) {
      return { approved: false, reason: `beta-adjusted exposure ${totalExposurePct.toFixed(1)}% exceeds max ${this.config.maxExposurePct}%` };
    }

    // ── Hard guardrails (code-enforced, LLM cannot bypass) ──

    // 4h timeframe confirmation (soft — overridable with high confidence)
    if (ctx?.indicators4h) {
      const trend4h = ctx.indicators4h.get(decision.pair)?.trend;
      const confidence = decision.confidence ?? 50;
      if (decision.action === 'LONG' && trend4h === 'bearish' && confidence < 65) {
        return { approved: false, reason: `4h trend bearish — need confidence >=65 (got ${confidence})` };
      }
      if (decision.action === 'SHORT' && trend4h === 'bullish' && confidence < 65) {
        return { approved: false, reason: `4h trend bullish — need confidence >=65 (got ${confidence})` };
      }
    }

    // Fear & Greed leverage cap
    if (ctx?.fearGreed) {
      const fgCap = ctx.fearGreedLeverageCap ?? 10;
      if ((ctx.fearGreed.value < 25 || ctx.fearGreed.value > 85) && decision.leverage > fgCap) {
        return { approved: false, reason: `Extreme F&G (${ctx.fearGreed.value}) — max leverage ${fgCap}x (requested ${decision.leverage}x)` };
      }
    }

    // Session loss scaling
    if (portfolio.sessionPnl < 0 && portfolio.balanceUsd > 0) {
      const lossPct = Math.abs(portfolio.sessionPnl) / portfolio.balanceUsd * 100;
      let adjustedMaxLeverage = this.config.maxLeverage;
      let adjustedMaxSize = this.config.maxPositionPct;
      if (lossPct >= 10) {
        adjustedMaxLeverage = Math.min(5, this.config.maxLeverage);
        adjustedMaxSize = Math.min(25, this.config.maxPositionPct);
      } else if (lossPct >= 5) {
        adjustedMaxLeverage = Math.floor(this.config.maxLeverage / 2);
        adjustedMaxSize = Math.floor(this.config.maxPositionPct / 2);
      }
      if (decision.leverage > adjustedMaxLeverage) {
        return { approved: false, reason: `Session loss ${lossPct.toFixed(1)}% — max leverage reduced to ${adjustedMaxLeverage}x` };
      }
      if (decision.size_pct > adjustedMaxSize) {
        return { approved: false, reason: `Session loss ${lossPct.toFixed(1)}% — max size reduced to ${adjustedMaxSize}%` };
      }
    }

    // Duplicate position check
    const existingSameDirection = portfolio.positions.find(
      p => p.pair === decision.pair && p.side === decision.action
    );
    if (existingSameDirection) {
      return { approved: false, reason: `Already ${decision.action} on ${decision.pair}` };
    }

    // Abnormal spread guard
    const SPREAD_MULTIPLIER = 2.5;
    const MIN_SPREAD_SAMPLES = 20;
    if (extra?.spreadPct != null && extra?.medianSpreadPct != null && extra.medianSpreadPct > 0) {
      if ((extra.spreadSampleSize ?? 0) >= MIN_SPREAD_SAMPLES) {
        if (extra.spreadPct > extra.medianSpreadPct * SPREAD_MULTIPLIER) {
          return { approved: false, reason: `Abnormal spread: ${(extra.spreadPct * 100).toFixed(3)}% vs median ${(extra.medianSpreadPct * 100).toFixed(3)}% (${SPREAD_MULTIPLIER}x threshold)` };
        }
      }
    }

    return { approved: true };
  }

  computeEnvelope(portfolio: PortfolioState, ctx: EnvelopeContext): DecisionEnvelope {
    let maxLev = this.config.maxLeverage;
    let maxSize = this.config.maxPositionPct;
    const constraints: string[] = [];

    // F&G cap
    if (ctx.fearGreed && (ctx.fearGreed.value < 25 || ctx.fearGreed.value > 85)) {
      const fgCap = ctx.fearGreedLeverageCap ?? 10;
      maxLev = Math.min(maxLev, fgCap);
      constraints.push('extreme_fear_greed');
    }

    // Session loss scaling
    if (portfolio.sessionPnl < 0 && portfolio.balanceUsd > 0) {
      const lossPct = Math.abs(portfolio.sessionPnl) / portfolio.balanceUsd * 100;
      if (lossPct >= 10) {
        maxLev = Math.min(5, maxLev);
        maxSize = Math.min(25, maxSize);
        constraints.push('session_loss_severe');
      } else if (lossPct >= 5) {
        maxLev = Math.floor(maxLev / 2);
        maxSize = Math.floor(maxSize / 2);
        constraints.push('session_loss_scaling');
      }
    }

    // Weekend
    if (ctx.isWeekend && ctx.weekendLeverageMultiplier) {
      maxLev = Math.floor(maxLev * ctx.weekendLeverageMultiplier);
      constraints.push('weekend_mode');
    }

    // Regime multiplier
    if (ctx.regimeLeverageMultiplier != null && ctx.regimeLeverageMultiplier < 1) {
      maxLev = Math.max(1, Math.round(maxLev * ctx.regimeLeverageMultiplier));
      constraints.push('regime_reduction');
    }

    const recLevMin = Math.max(1, Math.round(maxLev * 0.3));
    const recLevMax = Math.round(maxLev * 0.6);
    const recSizeMin = Math.max(5, Math.round(maxSize * 0.2));
    const recSizeMax = Math.round(maxSize * 0.5);

    const blockedPairs = portfolio.positions.map(p => `${p.pair}:${p.side}`);

    return {
      maxLeverage: maxLev,
      recommendedLeverage: [recLevMin, recLevMax],
      maxSizePct: maxSize,
      recommendedSizePct: [recSizeMin, recSizeMax],
      minConfidence: this.config.minConfidence ?? 55,
      blockedPairs,
      constraints,
    };
  }
}
