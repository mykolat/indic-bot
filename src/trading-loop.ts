import type { MarketDataFetcher, MarketSnapshot } from './binance/market-data.js';
import type { OrderExecutor } from './binance/orders.js';
import type { LLMClient } from './llm/client.js';
import type { RiskManager, TradeDecision, PortfolioState } from './risk/manager.js';
import type { SignalBuffer } from './webhook/signal-buffer.js';
import type { Logger } from './logger/index.js';
import type { NewsFetcher } from './news/news-fetcher.js';
import type { NewsCache } from './news/news-cache.js';
import type { NewsAnalystAgent } from './news/news-analyst.js';
import type { MacroFetcher } from './news/macro-fetcher.js';
import type { MacroAnalystAgent } from './news/macro-analyst.js';
import type { MacroAnalysis } from './llm/prompts.js';
import { computeIndicators, type Indicators } from './indicators/technical.js';
import { fetchFearGreed } from './news/fear-greed.js';
import { SessionMemory } from './memory/session.js';
import { computeSoulStats } from './memory/soul-stats.js';
import { CircuitBreaker } from './utils/circuit-breaker.js';
import { extractExternalInsights } from './utils/soul-utils.js';

interface TradingLoopDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  llm: LLMClient;
  orders: OrderExecutor;
  riskManager: RiskManager;
  signalBuffer: SignalBuffer;
  logger: Logger;
  newsClient?: NewsFetcher;
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
    stalePositionHours?: number;
    maxHoldHours?: number;
    minConfidence?: number;
    fearGreedLeverageCap?: number;
    layer3EmergencyPct?: number;  // default -5 — threshold for Layer 3 emergency close
  };
  macroFetcher?: MacroFetcher;
  macroAnalyst?: MacroAnalystAgent;
  macroRefreshIntervalMs?: number;  // default 10_800_000 (3h)
  fallbackLlm?: import('./llm/fallback-client.js').FallbackLLMClient;
  getSoulContent?: () => string | undefined;
  soulKeeper?: import('./memory/soul-keeper.js').SoulKeeper;
  soulReview?: import('./memory/soul-review.js').SoulReviewAgent;
  rssFetcher?: NewsFetcher;
  grokGrounder?: import('./news/grok-grounder.js').GrokGrounder;
  sourceHealth?: import('./news/source-health.js').SourceHealthMonitor;
  groundingConfig?: {
    minImportance: number;
    maxPerCycle: number;
  };
}

export class TradingLoop {
  private deps: TradingLoopDeps;
  private _shutdown = false;
  private cycleCount = 0;
  private lastClosedAt = new Map<string, number>();
  private lastOI = new Map<string, number>();
  private lastMacroRefresh = 0;
  private lastMacroAnalysis: MacroAnalysis | undefined;
  private binanceCircuitBreaker = new CircuitBreaker(3);

  constructor(deps: TradingLoopDeps) {
    this.deps = deps;
  }

  isShutdown(): boolean {
    return this._shutdown;
  }

  async runOnce(): Promise<number | undefined> {
    if (this._shutdown) return undefined;

    const { pairs, marketData, llm, orders, riskManager, signalBuffer, logger } = this.deps;

    // Circuit breaker: skip cycle if Binance has been failing consecutively
    if (this.binanceCircuitBreaker.isOpen()) {
      console.log(`[Loop] Binance circuit breaker open (${this.binanceCircuitBreaker.failureCount} consecutive failures) — skipping cycle`);
      logger.logError('CIRCUIT_BREAKER_OPEN', `Skipping cycle — ${this.binanceCircuitBreaker.failureCount} consecutive Binance failures`);
      return;
    }

    try {
      // 1. Fetch market data — use allSettled so one pair failure doesn't kill the cycle
      const settled = await Promise.allSettled(
        pairs.map((pair) => marketData.getSnapshot(pair)),
      );
      const rawSnapshots: MarketSnapshot[] = settled
        .filter((r): r is PromiseFulfilledResult<MarketSnapshot> => r.status === 'fulfilled')
        .map((r) => r.value);

      if (rawSnapshots.length === 0) {
        this.binanceCircuitBreaker.recordFailure();
        logger.logError('MARKET_DATA_FAILED', `All ${pairs.length} pair snapshots failed`);
        return;
      }
      this.binanceCircuitBreaker.recordSuccess();

      // Attach OI delta (% change vs previous cycle)
      const snapshots = rawSnapshots.map(snap => {
        const oiNum = parseFloat(snap.openInterest);
        const prevOI = this.lastOI.get(snap.pair);
        const oiDeltaPct = prevOI ? ((oiNum - prevOI) / prevOI) * 100 : 0;
        this.lastOI.set(snap.pair, oiNum);
        return { ...snap, openInterestDelta: oiDeltaPct };
      });

      // 2. Get portfolio state + real sessionPnl from Binance balance
      let portfolio: PortfolioState;
      try {
        portfolio = await marketData.getPortfolioState();
      } catch (err: any) {
        this.binanceCircuitBreaker.recordFailure();
        logger.logError('PORTFOLIO_FETCH_FAILED', err.message ?? 'unknown');
        return;
      }
      this.deps.memory.setStartBalance(portfolio.balanceUsd);
      const startBalance = this.deps.memory.getStartBalance()!;
      const sessionPnl = portfolio.balanceUsd - startBalance;
      portfolio.sessionPnl = sessionPnl;

      // Auto-exit stale positions
      const staleHours = this.deps.tradingConfig.stalePositionHours ?? 8;
      const maxHoldHours = this.deps.tradingConfig.maxHoldHours ?? 24;

      for (const pos of portfolio.positions) {
        let closeReason: string | null = null;

        if (pos.heldHours > maxHoldHours) {
          closeReason = `max_hold_${maxHoldHours}h`;
        } else if (pos.heldHours > staleHours && Math.abs(pos.unrealizedPnlPct) < 1) {
          closeReason = `stale_${staleHours}h`;
        }

        if (closeReason) {
          console.log(`[AutoExit] Closing ${pos.pair} ${pos.side} — ${closeReason} (held ${pos.heldHours.toFixed(1)}h, P&L: ${pos.unrealizedPnlPct.toFixed(1)}%)`);
          const result = await orders.close(pos.pair, pos.side);
          if (result.success) {
            logger.logTrade({ type: 'AUTO_CLOSE', pair: pos.pair, reason: closeReason });
            this.deps.soulKeeper?.addInvisibleExit({
              pair: pos.pair,
              side: pos.side,
              type: 'AUTO_CLOSE',
              pnlPct: pos.unrealizedPnlPct,
              timestamp: new Date().toISOString(),
            });
            this.lastClosedAt.set(pos.pair, Date.now());
            this.deps.memory.addTrade({
              pair: pos.pair,
              action: 'AUTO_CLOSE',
              pnlUsd: pos.unrealizedPnlPct * (pos.sizeUsd / pos.leverage) / 100,
              pnlPct: pos.unrealizedPnlPct,
              closedAt: new Date().toISOString(),
            });
            this.deps.memory.setLastOrderResult(
              `${pos.pair} AUTO_CLOSE — ${closeReason}`
            );
          }
        }
      }

      // 3. Compute indicators for each pair
      const indicators = new Map<string, Indicators>();
      for (const snap of snapshots) {
        const closes = snap.candles1h.map(c => parseFloat(c.close));
        const highs = snap.candles1h.map(c => parseFloat(c.high));
        const lows = snap.candles1h.map(c => parseFloat(c.low));
        const volumes = snap.candles1h.map(c => parseFloat(c.volume));
        indicators.set(snap.pair, computeIndicators(closes, highs, lows, volumes));
      }

      // Compute 4h indicators for each pair
      const indicators4h = new Map<string, Indicators>();
      for (const snap of snapshots) {
        if (snap.candles4h.length >= 20) {
          const closes4h = snap.candles4h.map(c => parseFloat(c.close));
          const highs4h = snap.candles4h.map(c => parseFloat(c.high));
          const lows4h = snap.candles4h.map(c => parseFloat(c.low));
          const volumes4h = snap.candles4h.map(c => parseFloat(c.volume));
          indicators4h.set(snap.pair, computeIndicators(closes4h, highs4h, lows4h, volumes4h));
        }
      }

      // 4. Refresh news cache if stale, then fetch sentiment
      if (this.deps.newsCache.shouldRefresh(this.deps.newsConfig.refreshIntervalH)) {
        const newsSource = this.deps.rssFetcher || this.deps.newsClient;
        if (newsSource) {
          console.log('[News] Cache stale — fetching fresh news...');
          const items = await newsSource.fetchNews(this.deps.newsConfig.maxItems);

          // Track source health for RSS feeds
          if (this.deps.sourceHealth && this.deps.rssFetcher) {
            const sources = [...new Set(items.map(i => i.source))];
            for (const s of sources) this.deps.sourceHealth.recordSuccess(s);
          }

          const analysis = await this.deps.newsAnalyst.analyze(items);

          // Grounding: verify high-importance claims via Grok
          if (this.deps.grokGrounder && analysis.top_signals?.length) {
            const cfg = this.deps.groundingConfig ?? { minImportance: 7, maxPerCycle: 2 };
            const toGround = analysis.top_signals
              .filter(s => s.needs_grounding && s.importance >= cfg.minImportance)
              .slice(0, cfg.maxPerCycle);

            const verifiedEntries: Array<{ claim: string; verified: boolean | null | undefined; confidence: number | undefined; summary: string | undefined; timestamp: string }> = [];
            for (const signal of toGround) {
              const gResult = await this.deps.grokGrounder.verify(signal.catalyst);
              if (gResult.summary) {
                signal.reasoning += ` [Grok: ${gResult.summary.slice(0, 150)}]`;
              }
              if (this.deps.sourceHealth) {
                this.deps.sourceHealth.recordGrokUsage(gResult.tokensUsed);
              }
              verifiedEntries.push({
                claim: gResult.claim,
                verified: gResult.verified,
                confidence: gResult.confidence,
                summary: gResult.summary,
                timestamp: new Date().toISOString(),
              });
            }

            if (verifiedEntries.length > 0 && this.deps.soulKeeper) {
              this.deps.soulKeeper.writeVerifiedIntel(verifiedEntries);
            }
          }

          const cacheState = {
            items,
            fetchedAt: new Date().toISOString(),
            analysis,
            analyzedAt: new Date().toISOString(),
          };
          this.deps.newsCache.save(cacheState);
          this.deps.newsCache.appendHistory(cacheState);
        }
      }
      // Log source health summary every 10 cycles
      if (this.deps.sourceHealth && this.cycleCount % 10 === 0) {
        console.log('[SourceHealth]\n' + this.deps.sourceHealth.getSummary());
      }
      const newsAnalysis = this.deps.newsCache.getAnalysis() ?? undefined;
      const fearGreed = await fetchFearGreed();

      // Macro refresh (every 3h)
      const macroIntervalMs = this.deps.macroRefreshIntervalMs ?? 10_800_000;
      if (this.deps.macroFetcher && this.deps.macroAnalyst && Date.now() - this.lastMacroRefresh > macroIntervalMs) {
        try {
          console.log('[Macro] Refreshing macro market data...');
          const [macroSnapshots, btcDom] = await Promise.all([
            this.deps.macroFetcher.fetch(),
            this.deps.macroFetcher.fetchBTCDominance(),
          ]);
          this.lastMacroAnalysis = await this.deps.macroAnalyst.analyze(macroSnapshots, btcDom);
          this.lastMacroRefresh = Date.now();
        } catch (err) {
          console.error('[Macro] Refresh failed:', err);
        }
      }

      // 5. Drain TradingView signals
      const signals = signalBuffer.drain();

      // 6. LLM analysis — 3-layer fallback
      const memState = this.deps.memory.load();
      const recentNewsWithAge = this.deps.newsCache.getRecentItems(48);
      const sessionPnlPct = startBalance > 0 ? (sessionPnl / startBalance) * 100 : 0;
      const lossPct = Math.abs(Math.min(sessionPnlPct, 0));
      const riskStatus = lossPct >= 10 ? 'critical' : lossPct >= 5 ? 'reduced' : 'normal';
      const soulContent = this.deps.soulKeeper?.read() ?? this.deps.getSoulContent?.();
      const promptData = {
        snapshots,
        indicators,
        indicators4h,
        portfolio,
        signals,
        news: [],
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        newsAnalysis,
        recentNewsWithAge,
        macroAnalysis: this.lastMacroAnalysis,
        sessionPnlPct,
        lastOrderResult: this.deps.memory.getLastOrderResult(),
        riskStatus,
        soulContent,
      };

      let decisions: TradeDecision[] = [];
      let currentLayer: 1 | 2 | 3 = 1;

      try {
        decisions = await llm.analyze(promptData);
      } catch (llmErr: any) {
        console.error('[Loop] Layer 1 (Codex API) failed:', llmErr?.message);
        logger.logError('LLM_LAYER1_FAILED', llmErr?.message ?? 'unknown');

        if (this.deps.fallbackLlm) {
          try {
            decisions = await this.deps.fallbackLlm.analyze(
              portfolio.positions,
              sessionPnlPct,
              soulContent,
            );
            currentLayer = 2;
            console.log('[Loop] Layer 2 (Fallback LLM) active — HOLD/CLOSE only');
          } catch (fallbackErr: any) {
            console.error('[Loop] Layer 2 (Fallback LLM) failed:', fallbackErr?.message);
            logger.logError('LLM_LAYER2_FAILED', fallbackErr?.message ?? 'unknown');
            currentLayer = 3;
          }
        } else {
          currentLayer = 3;
          console.log('[Loop] Layer 3 (rule-based) — no fallback LLM configured');
        }
      }

      // Layer 3: if significant loss and positions open — read Big Brother + emergency close
      const layer3Threshold = this.deps.tradingConfig.layer3EmergencyPct ?? -5;
      if (currentLayer === 3 && portfolio.positions.length > 0 && sessionPnlPct < layer3Threshold) {
        if (soulContent) {
          const insights = extractExternalInsights(soulContent);
          if (insights) {
            console.log('[Loop] Layer 3 — Big Brother instructions:\n' + insights);
          }
        }
        console.error(`[Loop] Layer 3: Loss ${sessionPnlPct.toFixed(1)}% + no LLM — closing all positions`);
        for (const pos of portfolio.positions) {
          const result = await orders.close(pos.pair, pos.side);
          if (result.success) {
            logger.logTrade({ type: 'EMERGENCY_CLOSE', pair: pos.pair, layer: 3, sessionPnlPct });
            this.lastClosedAt.set(pos.pair, Date.now());
            this.deps.memory.addTrade({
              pair: pos.pair,
              action: 'EMERGENCY_CLOSE',
              pnlUsd: pos.unrealizedPnlPct * (pos.sizeUsd / pos.leverage) / 100,
              pnlPct: pos.unrealizedPnlPct,
              closedAt: new Date().toISOString(),
            });
          }
        }
        logger.logPerformance({ balance: portfolio.balanceUsd, openPositions: 0, sessionPnl, cycleCount: this.cycleCount });
        this.cycleCount++;
        return;
      }

      // Extract next_check_minutes from LLM (Layer 1 only)
      let nextCheckMinutes = currentLayer === 1 ? llm.lastNextCheckMinutes : undefined;

      // Hard limits: if open positions → max 2 min, otherwise LLM decides (1-30)
      const hasPositions = portfolio.positions.length > 0;
      if (hasPositions && (nextCheckMinutes === undefined || nextCheckMinutes > 2)) {
        nextCheckMinutes = 1;
      }

      // Safety guard: in Layer 2/3, filter out any LONG/SHORT decisions
      if (currentLayer >= 2) {
        decisions = decisions.filter(d => d.action === 'HOLD' || d.action === 'CLOSE');
      }

      // 5. Process each decision
      for (const decision of decisions) {
        logger.logDecision({
          type: 'LLM_DECISION',
          ...decision,
          portfolio: { balance: portfolio.balanceUsd, sessionPnl },
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
        const validationCtx = {
          indicators4h: indicators4h.size > 0 ? indicators4h as Map<string, { trend: string }> : undefined,
          fearGreed,
          fearGreedLeverageCap: this.deps.tradingConfig.fearGreedLeverageCap,
        };
        const validation = riskManager.validate(decision, portfolio, validationCtx);
        if (!validation.approved) {
          logger.logDecision({ type: 'RISK_REJECTED', pair: decision.pair, reason: validation.reason });
          this.deps.soulKeeper?.addRejection({
            pair: decision.pair,
            action: decision.action,
            reason: validation.reason || 'unknown',
            timestamp: new Date().toISOString(),
          });
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
              logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
              this.lastClosedAt.set(decision.pair, Date.now());
              this.deps.memory.addTrade({
                pair: decision.pair,
                action: 'CLOSE',
                pnlUsd: parseFloat(pnlUsd.toFixed(2)),
                pnlPct: pos.unrealizedPnlPct,
                closedAt: new Date().toISOString(),
              });
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
            this.deps.memory.setLastOrderResult(
              `${decision.pair} ${decision.action} filled — SL/TP set`
            );
          } else {
            logger.logError('ORDER_FAIL', result.error || 'Unknown error');
            this.deps.memory.setLastOrderResult(
              `${decision.pair} ${decision.action} FAILED: ${result.error}`
            );
          }
        }
      }
      logger.logPerformance({
        balance: portfolio.balanceUsd,
        openPositions: portfolio.positions.length,
        sessionPnl,
        cycleCount: this.cycleCount,
      });
      this.cycleCount++;

      // Update soul stats
      if (this.deps.soulKeeper) {
        const stats = computeSoulStats(
          this.deps.memory.load().recent_trades,
          sessionPnlPct,
        );
        this.deps.soulKeeper.updateStats(stats);
      }

      if (nextCheckMinutes) {
        console.log(`[Loop] Next cycle in ${nextCheckMinutes} min${hasPositions ? ' (positions open — capped)' : ''}`);
      }

      // Soul review (LLM self-reflection)
      if (this.deps.soulReview) {
        const streak = this.deps.memory.load().recent_trades.reduce((s, t) => {
          if (s === null) return t.pnlPct < 0 ? -1 : t.pnlPct > 0 ? 1 : 0;
          if (s > 0 && t.pnlPct > 0) return s + 1;
          if (s < 0 && t.pnlPct < 0) return s - 1;
          return null;
        }, null as number | null) ?? 0;
        const consecutiveLosses = streak < 0 ? Math.abs(streak) : 0;
        if (this.deps.soulReview.shouldReview(this.cycleCount, consecutiveLosses, sessionPnlPct)) {
          try {
            await this.deps.soulReview.review(
              this.deps.memory.load().recent_trades,
              [],  // decision log — future enhancement
              this.cycleCount,
            );
          } catch (err) {
            console.error('[SoulReview] Error:', err);
          }
        }
      }
      return nextCheckMinutes;
    } catch (err: any) {
      logger.logError('LOOP_ERROR', err.message);
      return undefined;
    }
  }
}
