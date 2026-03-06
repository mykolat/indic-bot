export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
  confidence?: number;
  regime_override?: string;
}

export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;        // from Binance p.entryPrice
  unrealizedPnlPct: number;  // signed % of margin (e.g. -2.4 or +8.1)
  heldHours: number;         // hours since position opened
}

export interface PortfolioState {
  balanceUsd: number;      // walletBalance (total, incl. margin locked)
  availableUsd: number;    // availableBalance (free to use)
  positions: Position[];
  sessionPnl: number;
  drawdownPct: number;
}

export interface ValidationResult {
  approved: boolean;
  reason?: string;
  shutdown?: boolean;
}

interface RiskConfig {
  maxLeverage: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxStopLossPct: number;
  maxDrawdownPct: number;
  maxLossUsd: number;
  maxLossPct: number;  // % of balance; overrides maxLossUsd if > 0
  minConfidence?: number;  // reject decisions below this confidence (default 55)
}

export interface ValidationContext {
  indicators4h?: Map<string, { trend: string }>;
  fearGreed?: { value: number };
  fearGreedLeverageCap?: number;
}

export class RiskManager {
  constructor(private config: RiskConfig) { }

  validate(decision: TradeDecision, portfolio: PortfolioState, ctx?: ValidationContext): ValidationResult {
    if (decision.action === 'HOLD' || decision.action === 'CLOSE' || decision.action === 'FETCH_NEWS') {
      return { approved: true };
    }

    // Confidence check (only when minConfidence is configured)
    if (this.config.minConfidence != null) {
      const confidence = decision.confidence ?? 50;
      const minConf = this.config.minConfidence;
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

    if (portfolio.drawdownPct >= this.config.maxDrawdownPct) {
      return { approved: false, reason: `Drawdown ${portfolio.drawdownPct.toFixed(1)}% exceeded max ${this.config.maxDrawdownPct}% — shutdown triggered`, shutdown: true };
    }

    if (decision.leverage > this.config.maxLeverage) {
      return { approved: false, reason: `leverage ${decision.leverage}x exceeds max ${this.config.maxLeverage}x` };
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

    // Use margin (collateral) not notional — sizeUsd / leverage = actual margin used
    const currentExposureUsd = portfolio.positions.reduce((sum, p) => sum + p.sizeUsd / p.leverage, 0);
    const newPositionUsd = (decision.size_pct / 100) * portfolio.balanceUsd;
    const totalExposurePct = ((currentExposureUsd + newPositionUsd) / portfolio.balanceUsd) * 100;

    if (totalExposurePct > this.config.maxExposurePct) {
      return { approved: false, reason: `total exposure ${totalExposurePct.toFixed(1)}% exceeds max ${this.config.maxExposurePct}%` };
    }

    // ── Hard guardrails (code-enforced, LLM cannot bypass) ──

    // 4h timeframe confirmation (soft — overridable with high confidence)
    if (ctx?.indicators4h) {
      const trend4h = ctx.indicators4h.get(decision.pair)?.trend;
      const confidence = decision.confidence ?? 50;
      if (decision.action === 'LONG' && trend4h === 'bearish' && confidence < 80) {
        return { approved: false, reason: `4h trend bearish — need confidence >=80 (got ${confidence})` };
      }
      if (decision.action === 'SHORT' && trend4h === 'bullish' && confidence < 80) {
        return { approved: false, reason: `4h trend bullish — need confidence >=80 (got ${confidence})` };
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

    return { approved: true };
  }
}
