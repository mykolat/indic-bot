import type { MarketDataFetcher, MarketSnapshot } from './binance/market-data.js';
import type { OrderExecutor } from './binance/orders.js';
import type { LLMClient } from './llm/client.js';
import type { RiskManager, TradeDecision, PortfolioState } from './risk/manager.js';
import type { SignalBuffer } from './webhook/signal-buffer.js';
import type { Logger } from './logger/index.js';
import type { CryptoPanicClient } from './news/cryptopanic.js';
import type { NewsCache } from './news/news-cache.js';
import type { NewsAnalystAgent } from './news/news-analyst.js';
import { computeIndicators, type Indicators } from './indicators/technical.js';
import { fetchFearGreed } from './news/fear-greed.js';
import { SessionMemory } from './memory/session.js';

interface TradingLoopDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  llm: LLMClient;
  orders: OrderExecutor;
  riskManager: RiskManager;
  signalBuffer: SignalBuffer;
  logger: Logger;
  newsClient?: CryptoPanicClient;
  memory: SessionMemory;
  newsCache: NewsCache;
  newsAnalyst: NewsAnalystAgent;
  newsConfig: {
    refreshIntervalH: number;
    maxItems: number;
  };
  churnCooldownMs: number;
  tradingConfig: {
    targetReturnPct: number;
    minTakeProfitPct: number;
    maxLeverage: number;
    maxPositionPct: number;
    maxStopLossPct: number;
  };
}

export class TradingLoop {
  private deps: TradingLoopDeps;
  private _shutdown = false;
  private sessionPnl = 0;
  private cycleCount = 0;
  private lastClosedAt = new Map<string, number>();
  private lastOI = new Map<string, number>();

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
      const rawSnapshots: MarketSnapshot[] = await Promise.all(
        pairs.map((pair) => marketData.getSnapshot(pair)),
      );

      // Attach OI delta (% change vs previous cycle)
      const snapshots = rawSnapshots.map(snap => {
        const oiNum = parseFloat(snap.openInterest);
        const prevOI = this.lastOI.get(snap.pair);
        const oiDeltaPct = prevOI ? ((oiNum - prevOI) / prevOI) * 100 : 0;
        this.lastOI.set(snap.pair, oiNum);
        return { ...snap, openInterestDelta: oiDeltaPct };
      });

      // 2. Get portfolio state
      const portfolio: PortfolioState = await marketData.getPortfolioState();
      portfolio.sessionPnl = this.sessionPnl;

      // 3. Compute indicators for each pair
      const indicators = new Map<string, Indicators>();
      for (const snap of snapshots) {
        const closes = snap.candles1h.map(c => parseFloat(c.close));
        const highs = snap.candles1h.map(c => parseFloat(c.high));
        const lows = snap.candles1h.map(c => parseFloat(c.low));
        const volumes = snap.candles1h.map(c => parseFloat(c.volume));
        indicators.set(snap.pair, computeIndicators(closes, highs, lows, volumes));
      }

      // 4. Refresh news cache if stale, then fetch sentiment
      if (this.deps.newsClient && this.deps.newsCache.shouldRefresh(this.deps.newsConfig.refreshIntervalH)) {
        console.log('[News] Cache stale — fetching fresh news...');
        const items = await this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems);
        const analysis = await this.deps.newsAnalyst.analyze(items);
        const cacheState = {
          items,
          fetchedAt: new Date().toISOString(),
          analysis,
          analyzedAt: new Date().toISOString(),
        };
        this.deps.newsCache.save(cacheState);
        this.deps.newsCache.appendHistory(cacheState);
      }
      const newsAnalysis = this.deps.newsCache.getAnalysis() ?? undefined;
      const fearGreed = await fetchFearGreed();

      // 5. Drain TradingView signals
      const signals = signalBuffer.drain();

      // 6. LLM analysis with enriched data
      const memState = this.deps.memory.load();
      const decisions = await llm.analyze({
        snapshots,
        indicators,
        portfolio,
        signals,
        news: [],
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        newsAnalysis,
      });

      // 5. Process each decision
      for (const decision of decisions) {
        logger.logDecision({
          type: 'LLM_DECISION',
          ...decision,
          portfolio: { balance: portfolio.balanceUsd, sessionPnl: this.sessionPnl },
        });

        if (decision.action === 'FETCH_NEWS') {
          console.log(`[News] LLM requested refresh: ${decision.reasoning}`);
          if (this.deps.newsClient) {
            const items = await this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems);
            const analysis = await this.deps.newsAnalyst.analyze(items);
            const cacheState = {
              items,
              fetchedAt: new Date().toISOString(),
              analysis,
              analyzedAt: new Date().toISOString(),
            };
            this.deps.newsCache.save(cacheState);
            this.deps.newsCache.appendHistory(cacheState);
          }
          continue;
        }

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
            const result = await orders.close(decision.pair, pos.side);
            if (result.success) {
              const pnlUsd = pos.unrealizedPnlPct * (pos.sizeUsd / pos.leverage) / 100;
              this.sessionPnl += pnlUsd;
              logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
              this.lastClosedAt.set(decision.pair, Date.now());
            } else {
              logger.logError('ORDER_FAIL', result.error || 'Unknown error');
            }
          }
        } else {
          const lastClose = this.lastClosedAt.get(decision.pair);
          if (lastClose && Date.now() - lastClose < this.deps.churnCooldownMs) {
            const remainingMin = Math.round((this.deps.churnCooldownMs - (Date.now() - lastClose)) / 60000);
            console.log(`[Churn] Skipping ${decision.pair} ${decision.action} — cooldown ${remainingMin}m remaining`);
            continue;
          }
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
      logger.logPerformance({
        balance: portfolio.balanceUsd,
        openPositions: portfolio.positions.length,
        sessionPnl: this.sessionPnl,
        cycleCount: this.cycleCount,
      });
      this.cycleCount++;
    } catch (err: any) {
      logger.logError('LOOP_ERROR', err.message);
    }
  }
}
