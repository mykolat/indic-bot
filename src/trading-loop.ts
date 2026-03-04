import type { MarketDataFetcher, MarketSnapshot } from './binance/market-data.js';
import type { OrderExecutor } from './binance/orders.js';
import type { LLMClient } from './llm/client.js';
import type { RiskManager, TradeDecision, PortfolioState } from './risk/manager.js';
import type { SignalBuffer } from './webhook/signal-buffer.js';
import type { Logger } from './logger/index.js';

interface TradingLoopDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  llm: LLMClient;
  orders: OrderExecutor;
  riskManager: RiskManager;
  signalBuffer: SignalBuffer;
  logger: Logger;
}

export class TradingLoop {
  private deps: TradingLoopDeps;
  private _shutdown = false;
  private sessionPnl = 0;

  constructor(deps: TradingLoopDeps) {
    this.deps = deps;
  }

  isShutdown(): boolean {
    return this._shutdown;
  }

  async runOnce(): Promise<void> {
    if (this._shutdown) return;

    const { pairs, marketData, llm, orders, riskManager, signalBuffer, logger } = this.deps;

    try {
      // 1. Fetch market data
      const snapshots: MarketSnapshot[] = await Promise.all(
        pairs.map((pair) => marketData.getSnapshot(pair)),
      );

      // 2. Get portfolio state
      const portfolio: PortfolioState = await marketData.getPortfolioState();
      portfolio.sessionPnl = this.sessionPnl;

      // 3. Drain TradingView signals
      const signals = signalBuffer.drain();

      // 4. LLM analysis
      const decisions = await llm.analyze(snapshots, portfolio, signals);

      // 5. Process each decision
      for (const decision of decisions) {
        logger.logDecision({
          type: 'LLM_DECISION',
          ...decision,
          portfolio: { balance: portfolio.balanceUsd, sessionPnl: this.sessionPnl },
        });

        if (decision.action === 'HOLD') continue;

        // 6. Risk check
        const validation = riskManager.validate(decision, portfolio);
        if (!validation.approved) {
          logger.logDecision({ type: 'RISK_REJECTED', pair: decision.pair, reason: validation.reason });
          if (validation.shutdown) {
            this._shutdown = true;
            logger.logError('SHUTDOWN', 'Max loss reached — stopping bot');
          }
          continue;
        }

        // 7. Execute
        if (decision.action === 'CLOSE') {
          const pos = portfolio.positions.find((p) => p.pair === decision.pair);
          if (pos) {
            const result = await orders.close(decision.pair, pos.sizeUsd, pos.side);
            if (result.success) {
              logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
            } else {
              logger.logError('ORDER_FAIL', result.error || 'Unknown error');
            }
          }
        } else {
          const result = await orders.execute(decision, portfolio.balanceUsd);
          if (result.success) {
            logger.logTrade({
              type: decision.action,
              pair: decision.pair,
              size_pct: decision.size_pct,
              leverage: decision.leverage,
              orderId: result.orderId,
            });
          } else {
            logger.logError('ORDER_FAIL', result.error || 'Unknown error');
          }
        }
      }
    } catch (err: any) {
      logger.logError('LOOP_ERROR', err.message);
    }
  }
}
