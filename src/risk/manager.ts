export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
}

export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
}

export interface PortfolioState {
  balanceUsd: number;
  positions: Position[];
  sessionPnl: number;
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
  maxLossUsd: number;
}

export class RiskManager {
  constructor(private config: RiskConfig) {}

  validate(decision: TradeDecision, portfolio: PortfolioState): ValidationResult {
    if (decision.action === 'HOLD' || decision.action === 'CLOSE') {
      return { approved: true };
    }

    if (portfolio.sessionPnl <= -this.config.maxLossUsd) {
      return { approved: false, reason: 'Session loss exceeded max — shutdown triggered', shutdown: true };
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

    const currentExposureUsd = portfolio.positions.reduce((sum, p) => sum + p.sizeUsd, 0);
    const newPositionUsd = (decision.size_pct / 100) * portfolio.balanceUsd;
    const totalExposurePct = ((currentExposureUsd + newPositionUsd) / portfolio.balanceUsd) * 100;

    if (totalExposurePct > this.config.maxExposurePct) {
      return { approved: false, reason: `total exposure ${totalExposurePct.toFixed(1)}% exceeds max ${this.config.maxExposurePct}%` };
    }

    return { approved: true };
  }
}
