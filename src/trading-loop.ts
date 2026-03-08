import type { MarketDataFetcher, MarketSnapshot } from './binance/market-data.js';
import type { OrderExecutor } from './binance/orders.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runLayer1Experts } from './llm/agents.js';
import type { LLMClient } from './llm/client.js';
import type { RiskManager, TradeDecision, PortfolioState } from './risk/manager.js';
import { BETA_TO_BTC } from './risk/manager.js';
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
import { computeMemoryStats } from './memory/memory-stats.js';
import { CircuitBreaker } from './utils/circuit-breaker.js';
import { extractExternalInsights } from './utils/soul-utils.js';
import { MarketRegime, classifyRegime } from './market/regime-classifier.js';
import { RegimeHysteresis } from './market/regime-hysteresis.js';
import { getFilterProfile, type FilterProfile } from './market/filter-profiles.js';
import { PreScreener, type ScreenAllResult } from './market/pre-screener.js';
import { computeConfluence } from './market/confluence.js';
import type { DecisionJournal, JournalEntry } from './logging/decision-journal.js';
import type { TradeStoryLogger } from './logging/trade-story.js';
import type { CryptoNews } from './news/types.js';
import type { SwarmAgent } from './llm/swarm-agent.js';
import { insertCycle, insertTradeDecision, insertTradeExecution, insertTradeClose, insertRiskValidation, insertIndicatorSnapshot, insertLlmConversation, getOpenPositionContexts, getDbOpenPositions, getMarketSnapshotsSince, getRecentDecisions, insertSlTpAdjustment, updateExecutionSlTp, getRecentLiquidations } from './db/repository.js';
import { getPool } from './db/connection.js';
import { detectGhostPositions } from './position-reconciler.js';
import type { AdjustContext } from './risk/manager.js';
import { buildWatchdogSummary } from './watchdog-summary.js';
import { buildDiversityContext, type PairDecisionEntry } from './market/pair-diversity.js';
import type { Watchdog, Tp1Target } from './watchdog.js';
import { buildNewsMarketFusion, formatFusionBlock } from './news/news-market-fusion.js';
import type { GroundingResult } from './news/grok-grounder.js';
import { getMarketSession, formatSessionPromptBlock } from './market/session.js';

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
    minLeverage?: number;
    stalePositionHours?: number;
    maxHoldHours?: number;
    minConfidence?: number;
    fearGreedLeverageCap?: number;
    weekendLeverageMultiplier?: number;
    swarmVolumeThreshold?: number;
    layer3EmergencyPct?: number;  // default -5 — threshold for Layer 3 emergency close
    maxExposurePct?: number;      // default 150 — mirrors RiskManager config
  };
  macroFetcher?: MacroFetcher;
  macroAnalyst?: MacroAnalystAgent;
  grokMacroAnalyst?: import('./news/grok-macro.js').GrokMacroAnalyst;
  macroRefreshIntervalMs?: number;  // default 10_800_000 (3h)
  fallbackLlm?: import('./llm/fallback-client.js').FallbackLLMClient;
  swarmAgent?: SwarmAgent;
  flashCrashScanner?: import('./news/flash-crash.js').FlashCrashScanner;
  getSoulContent?: () => string | undefined;
  memoryKeeper?: import('./memory/memory-keeper.js').MemoryKeeper;
  memoryReview?: import('./memory/memory-review.js').MemoryReviewAgent;
  episodicAgent?: import('./llm/episodic-agent.js').EpisodicAgent;
  episodicStore?: import('./memory/episodic-store.js').EpisodicStore;
  embeddingClient?: import('./llm/embedding-client.js').EmbeddingClient;
  rssFetcher?: NewsFetcher;
  grokGrounder?: import('./news/grok-grounder.js').GrokGrounder;
  sourceHealth?: import('./news/source-health.js').SourceHealthMonitor;
  groundingConfig?: {
    minImportance: number;
    maxPerCycle: number;
  };
  decisionJournal?: DecisionJournal;
  tradeStoryLogger?: TradeStoryLogger;
  sessionId?: string;
  watchdog?: Watchdog;
  preScreener?: PreScreener;
  positionManagement?: {
    enabled: boolean;
    tp1CloseRatio: number;
    breakevenBufferPct: number;
    trailing: { enabled: boolean; callbackRatePct: number };
    regimeOverrides: Record<string, Partial<{ tp1CloseRatio: number; callbackRatePct: number }>>;
  };
}

export class TradingLoop {
  private deps: TradingLoopDeps;
  private _shutdown = false;
  private cycleCount = 0;
  private lastClosedAt = new Map<string, number>();
  private lastOI = new Map<string, number>();
  private spreadHistory = new Map<string, number[]>();
  private lastMacroRefresh = 0;
  private lastMacroAnalysis: MacroAnalysis | undefined;
  private binanceCircuitBreaker = new CircuitBreaker(3);
  private regimeHysteresis = new RegimeHysteresis(3);
  private staticSoulCache: string | null = null;
  private lastNewsMarketFusion?: string;
  private _lastPositionCount = 0;
  private pairDecisionHistory: PairDecisionEntry[] = [];

  constructor(deps: TradingLoopDeps) {
    this.deps = deps;
  }

  setWatchdog(watchdog: Watchdog): void {
    this.deps.watchdog = watchdog;
  }

  private saveEpisode(
    pair: string,
    side: string,
    regime: string,
    indicators: Map<string, import('./indicators/technical.js').Indicators>,
    heldHours: number,
    pnlPct: number,
    reasoning: string,
  ): void {
    if (!this.deps.episodicStore || !this.deps.embeddingClient) return;
    const ind = indicators.get(pair);
    const summary = [
      `Pair: ${pair}. Direction: ${side}.`,
      `Regime: ${regime}.`,
      `RSI: ${ind?.rsi?.toFixed(0) ?? '?'}. Volume: ${ind?.volumeRatio?.toFixed(1) ?? '?'}x.`,
      `ADX: ${ind?.adx?.toFixed(0) ?? '?'}. Trend: ${ind?.trend ?? 'unknown'}.`,
      `Held: ${heldHours.toFixed(1)}h. PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%.`,
      `Reasoning: ${reasoning}`,
    ].join(' ');

    this.deps.embeddingClient.getEmbedding(summary)
      .then(embedding => {
        this.deps.episodicStore!.addEpisode({
          id: `${pair}-${Date.now()}`,
          timestamp: Date.now(),
          textSummary: summary,
          embedding,
          resultPnl: pnlPct,
        });
        console.log(`[EpisodicRAG] Saved episode for ${pair} (PnL: ${pnlPct.toFixed(1)}%)`);
      })
      .catch(err => console.error('[EpisodicRAG] Failed:', err.message));
  }

  isShutdown(): boolean {
    return this._shutdown;
  }

  hasOpenPositions(): boolean {
    return this._lastPositionCount > 0;
  }

  private async runGroundingAndFusion(
    analysis: import('./news/news-cache.js').NewsAnalysis,
  ): Promise<void> {
    const groundingMap = new Map<string, GroundingResult>();

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
        groundingMap.set(signal.catalyst, gResult);
        verifiedEntries.push({
          claim: gResult.claim,
          verified: gResult.verified,
          confidence: gResult.confidence,
          summary: gResult.summary,
          timestamp: new Date().toISOString(),
        });
      }

      if (verifiedEntries.length > 0 && this.deps.memoryKeeper) {
        this.deps.memoryKeeper.writeVerifiedIntel(verifiedEntries);
      }
    }

    // Build news-market fusion
    if (analysis.top_signals?.length) {
      try {
        const pairSnaps = new Map<string, import('./db/types.js').DbMarketSnapshot[]>();
        for (const pair of this.deps.pairs) {
          const snaps = await getMarketSnapshotsSince(pair, 15);
          if (snaps.length > 0) pairSnaps.set(pair, snaps);
        }
        const entries = buildNewsMarketFusion(
          analysis.top_signals,
          groundingMap,
          pairSnaps,
          new Date().toISOString(),
        );
        if (entries.length > 0) {
          this.lastNewsMarketFusion = formatFusionBlock(entries);
          console.log(`[NewsMarketFusion] ${entries.length} events correlated`);
        } else {
          this.lastNewsMarketFusion = undefined;
        }
      } catch (e: any) {
        console.error('[NewsMarketFusion] Error:', e.message);
      }
    }
  }

  private getStaticSoul(): string | undefined {
    if (this.staticSoulCache) return this.staticSoulCache;

    if (this.deps.getSoulContent) {
      this.staticSoulCache = this.deps.getSoulContent() ?? null;
      if (this.staticSoulCache) return this.staticSoulCache;
    }

    const soulPath = join(process.env.DATA_DIR || './data', 'soul.md');
    if (existsSync(soulPath)) {
      this.staticSoulCache = readFileSync(soulPath, 'utf8');
      return this.staticSoulCache;
    }
    return undefined;
  }

  async runOnce(): Promise<number | undefined> {
    if (this._shutdown) return undefined;

    const { pairs, marketData, llm, orders, riskManager, signalBuffer, logger } = this.deps;

    // Circuit breaker: skip cycle if Binance has been failing consecutively
    if (this.binanceCircuitBreaker.isOpen()) {
      const state = this.binanceCircuitBreaker.state;
      console.log(`[Loop] Binance circuit breaker ${state} (${this.binanceCircuitBreaker.failureCount} consecutive failures) — skipping cycle`);
      logger.logError('CIRCUIT_BREAKER_OPEN', `Skipping cycle — ${this.binanceCircuitBreaker.failureCount} consecutive Binance failures (${state})`);
      return;
    }

    // Log when probing after half-open recovery
    if (this.binanceCircuitBreaker.state === 'half-open') {
      console.log(`[Loop] Circuit breaker half-open — probing Binance with this cycle`);
    }

    if (this.deps.flashCrashScanner) {
      const flashResult = await this.deps.flashCrashScanner.scan(
        this.deps.marketData as any,
        this.deps.pairs,
      );
      if (flashResult.verdict === 'UNCONFIRMED') {
        console.warn(`[FlashCrash] UNCONFIRMED: ${flashResult.reason}`);
      }
      if (flashResult.verdict === 'PANIC') {
        console.warn('[Loop] FlashCrashScanner detected PANIC! Emergency closing all positions.');
        logger.logError('FLASH_CRASH_DETECTED', 'Scanner detected panic sentiment — emergency close triggered.');

        try {
          const portfolio = await marketData.getPortfolioState();
          for (const pos of portfolio.positions) {
            const result = await orders.close(pos.pair, pos.side);
            if (result.success) {
              logger.logTrade({ type: 'EMERGENCY_CLOSE', pair: pos.pair, reason: 'flash_crash_panic' });
              this.lastClosedAt.set(pos.pair, Date.now());
            }
          }
        } catch (err: any) {
          logger.logError('FLASH_CRASH_CLOSE_FAILED', err.message ?? 'unknown');
        }
        return undefined;
      }
    }

    // Process TP1 hits from watchdog (position management)
    if (this.deps.watchdog && this.deps.positionManagement?.enabled) {
      const tp1Hits = this.deps.watchdog.drainTp1Hits();
      for (const hit of tp1Hits) {
        try {
          const pm = this.deps.positionManagement;
          const regime = this.regimeHysteresis.get(hit.pair);
          const override = pm.regimeOverrides[regime] ?? {};
          const closeRatio = override.tp1CloseRatio ?? pm.tp1CloseRatio;

          console.log(`[PosMgmt] TP1 hit ${hit.pair} ${hit.side} — closing ${(closeRatio * 100).toFixed(0)}%, moving SL to breakeven`);

          const partialResult = await orders.partialClose(hit.pair, hit.side, closeRatio);
          if (partialResult.success) {
            logger.logTrade({ type: 'PARTIAL_CLOSE', pair: hit.pair, reason: 'tp1_hit', ratio: closeRatio });
          }

          const beResult = await orders.moveSlToBreakeven(hit.pair, hit.side, hit.entryPrice, pm.breakevenBufferPct);
          if (beResult.success) {
            insertSlTpAdjustment({
              pair: hit.pair,
              side: hit.side === 'LONG' ? 'BUY' : 'SELL',
              execution_id: hit.executionId,
              new_sl: beResult.slPrice,
              reasoning: 'tp1_hit_breakeven',
            }).catch(() => {});
          }
        } catch (err: any) {
          console.error(`[PosMgmt] TP1 processing failed for ${hit.pair}:`, err.message);
        }
      }
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
      const allSnapshots = rawSnapshots.map(snap => {
        const oiNum = parseFloat(snap.openInterest);
        const prevOI = this.lastOI.get(snap.pair);
        const oiDeltaPct = prevOI ? ((oiNum - prevOI) / prevOI) * 100 : 0;
        this.lastOI.set(snap.pair, oiNum);
        return { ...snap, openInterestDelta: oiDeltaPct };
      });

      // Stale data guard — skip snapshots older than 5 minutes
      const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
      const now = Date.now();
      const snapshots = allSnapshots.filter(s => {
        if (s.fetchedAt && (now - s.fetchedAt) > MAX_SNAPSHOT_AGE_MS) {
          console.warn(`[Loop] Stale snapshot for ${s.pair}: ${((now - s.fetchedAt) / 1000).toFixed(0)}s old — skipping`);
          return false;
        }
        return true;
      });
      if (snapshots.length === 0) {
        console.error('[Loop] ALL_SNAPSHOTS_STALE: All market snapshots older than 5 minutes');
        return;
      }

      // Track spread history per pair (rolling window of 50)
      for (const snap of snapshots) {
        if (snap.spreadPct != null) {
          let history = this.spreadHistory.get(snap.pair);
          if (!history) {
            history = [];
            this.spreadHistory.set(snap.pair, history);
          }
          history.push(snap.spreadPct);
          if (history.length > 50) history.shift();
        }
      }

      // 2. Get portfolio state + real sessionPnl from Binance balance
      let portfolio: PortfolioState;
      try {
        portfolio = await marketData.getPortfolioState();
      } catch (err: any) {
        this.binanceCircuitBreaker.recordFailure();
        logger.logError('PORTFOLIO_FETCH_FAILED', err.message ?? 'unknown');
        return;
      }
      this._lastPositionCount = portfolio.positions.length;
      this.deps.memory.setStartBalance(portfolio.balanceUsd);
      const startBalance = this.deps.memory.getStartBalance()!;
      let hwm = this.deps.memory.getHighWaterMark();
      if (hwm === undefined || portfolio.balanceUsd > hwm) {
        hwm = portfolio.balanceUsd;
        this.deps.memory.setHighWaterMark(hwm);
      }
      const sessionPnl = portfolio.balanceUsd - startBalance;
      portfolio.sessionPnl = sessionPnl;
      portfolio.drawdownPct = hwm > 0 ? ((hwm - portfolio.balanceUsd) / hwm) * 100 : 0;

      // Reconcile: detect positions closed on Binance (SL/TP) but still "open" in DB
      try {
        const dbOpen = await getDbOpenPositions();
        const ghosts = detectGhostPositions(dbOpen, portfolio.positions);
        for (const ghost of ghosts) {
          console.log(`[Reconcile] Ghost position: ${ghost.pair} ${ghost.side} (exec #${ghost.id}) — closed on Binance, recording in DB`);

          // Enrich with execution data
          let exitPrice: number | undefined;
          let pnlUsd: number | undefined;
          let pnlPct: number | undefined;
          let heldHours: number | undefined;
          try {
            const { rows } = await getPool().query(
              'SELECT fill_price, leverage, quantity, created_at FROM trade_executions WHERE id = $1',
              [ghost.id],
            );
            if (rows[0]) {
              const entry = parseFloat(rows[0].fill_price);
              const qty = parseFloat(rows[0].quantity);
              const lev = parseFloat(rows[0].leverage);
              const entryTime = new Date(rows[0].created_at).getTime();
              heldHours = (Date.now() - entryTime) / 3600000;

              // Use current mark price as approximate exit price
              const snap = snapshots.find(s => s.pair === ghost.pair);
              if (snap) {
                exitPrice = snap.price;
                const direction = ghost.side === 'BUY' ? 1 : -1;
                pnlUsd = (exitPrice - entry) * qty * direction;
                const margin = (entry * qty) / lev;
                pnlPct = margin > 0 ? (pnlUsd / margin) * 100 : undefined;
              }
            }
          } catch { /* best effort */ }

          if (pnlUsd !== undefined && heldHours !== undefined && heldHours > 1) {
            console.log(`[Reconcile] ${ghost.pair}: PnL $${pnlUsd.toFixed(4)} (excl. funding fees, held ${heldHours.toFixed(1)}h)`);
          }

          insertTradeClose({
            execution_id: ghost.id,
            pair: ghost.pair,
            exit_reason: 'sl_tp_triggered',
            exit_price: exitPrice,
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            held_hours: heldHours,
          }).catch(() => {});
        }
      } catch (err: any) {
        console.error('[Reconcile] Error:', err?.message);
      }

      // Auto-exit stale positions
      const staleHours = this.deps.tradingConfig.stalePositionHours ?? 8;
      const maxHoldHours = this.deps.tradingConfig.maxHoldHours ?? 24;

      for (const pos of portfolio.positions) {
        let closeReason: string | null = null;

        if (pos.heldHours > maxHoldHours) {
          closeReason = `max_hold_${maxHoldHours}h`;
        } else if (pos.heldHours > staleHours && pos.unrealizedPnlPct < 1) {
          closeReason = `stale_${staleHours}h`;
        }

        if (closeReason) {
          console.log(`[AutoExit] Closing ${pos.pair} ${pos.side} — ${closeReason} (held ${pos.heldHours.toFixed(1)}h, P&L: ${pos.unrealizedPnlPct.toFixed(1)}%)`);
          const result = await orders.close(pos.pair, pos.side);
          if (result.success) {
            logger.logTrade({ type: 'AUTO_CLOSE', pair: pos.pair, reason: closeReason });
            this.deps.memoryKeeper?.addInvisibleExit({
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

            // Log trade story
            if (this.deps.tradeStoryLogger) {
              this.deps.tradeStoryLogger.log({
                pair: pos.pair,
                direction: pos.side,
                entryTime: new Date(Date.now() - pos.heldHours * 3600000).toISOString(),
                exitTime: new Date().toISOString(),
                entryPrice: pos.entryPrice,
                exitPrice: typeof result.fillPrice === 'number' ? result.fillPrice : pos.entryPrice,
                pnlPct: pos.unrealizedPnlPct,
                regimeAtEntry: 'unknown', // History tracking can be improved later
                regimeAtExit: 'unknown',
                story: `Automatically closed positions after ${pos.heldHours.toFixed(1)}h due to ${closeReason}.`,
                lesson: 'Auto-exit triggered to limit time risk.'
              });
            }
            this.saveEpisode(pos.pair, pos.side, 'unknown', new Map(), pos.heldHours, pos.unrealizedPnlPct, closeReason);

            // Save auto-close to DB with attribution
            insertTradeClose({
              pair: pos.pair,
              exit_reason: closeReason.startsWith('max_hold') ? 'auto_max_hold' : 'auto_stale',
              pnl_usd: pos.unrealizedPnlPct * (pos.sizeUsd / pos.leverage) / 100,
              pnl_pct: pos.unrealizedPnlPct,
              held_hours: pos.heldHours,
              order_id: result.orderId,
              holding_time_minutes: pos.heldHours * 60,
            }).catch(() => {});
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
        const openTimes = snap.candles1h.map(c => c.openTime);
        indicators.set(snap.pair, computeIndicators(closes, highs, lows, volumes, openTimes));
      }

      // Compute 4h indicators for each pair
      const indicators4h = new Map<string, Indicators>();
      for (const snap of snapshots) {
        if (snap.candles4h.length >= 20) {
          const closes4h = snap.candles4h.map(c => parseFloat(c.close));
          const highs4h = snap.candles4h.map(c => parseFloat(c.high));
          const lows4h = snap.candles4h.map(c => parseFloat(c.low));
          const volumes4h = snap.candles4h.map(c => parseFloat(c.volume));
          const openTimes4h = snap.candles4h.map(c => c.openTime);
          indicators4h.set(snap.pair, computeIndicators(closes4h, highs4h, lows4h, volumes4h, openTimes4h));
        }
      }

      // 4. Refresh news cache if stale, then fetch sentiment
      if (this.deps.newsCache.shouldRefresh(this.deps.newsConfig.refreshIntervalH)) {
        const fetchers = [];
        if (this.deps.rssFetcher) fetchers.push(this.deps.rssFetcher.fetchNews(this.deps.newsConfig.maxItems));
        if (this.deps.newsClient) fetchers.push(this.deps.newsClient.fetchNews(this.deps.newsConfig.maxItems));

        if (fetchers.length > 0) {
          console.log(`[News] Cache stale — fetching from ${fetchers.length} sources...`);
          const results = await Promise.allSettled(fetchers);
          const allItems: CryptoNews[] = [];

          for (const res of results) {
            if (res.status === 'fulfilled') {
              allItems.push(...res.value);
            }
          }

          // Deduplicate by title, preferring CryptoPanic/non-RSS
          const seen = new Map<string, CryptoNews>();
          for (const item of allItems) {
            const key = item.title.toLowerCase().trim().replace(/\s+/g, ' ');
            const existing = seen.get(key);

            // Priority: keep if new OR if existing is RSS and new is not
            if (!existing || (existing.source.toLowerCase().includes('rss') && !item.source.toLowerCase().includes('rss'))) {
              seen.set(key, item);
            }
          }
          const uniqueItems = Array.from(seen.values());

          // Track source health
          if (this.deps.sourceHealth) {
            const sources = [...new Set(uniqueItems.map(i => i.source))];
            for (const s of sources) this.deps.sourceHealth.recordSuccess(s);
          }

          const analysis = await this.deps.newsAnalyst.analyze(uniqueItems);

          await this.runGroundingAndFusion(analysis);

          const cacheState = {
            items: uniqueItems,
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
      const newsCacheState = this.deps.newsCache.load();
      const newsAnalysis = newsCacheState?.analysis ?? undefined;
      const newsAnalyzedAt = newsCacheState?.analyzedAt ?? undefined;
      const fearGreed = await fetchFearGreed();

      // Macro refresh (every 3h) — prefer Grok with live search, fallback to Apify
      const macroIntervalMs = this.deps.macroRefreshIntervalMs ?? 10_800_000;
      if (Date.now() - this.lastMacroRefresh > macroIntervalMs) {
        if (this.deps.grokMacroAnalyst) {
          try {
            console.log('[Macro] Refreshing via Grok live search...');
            this.lastMacroAnalysis = await this.deps.grokMacroAnalyst.analyze(this.deps.pairs);
            this.lastMacroRefresh = Date.now();
          } catch (err: any) {
            console.error('[Macro] Grok macro refresh failed:', err.message);
          }
        } else if (this.deps.macroFetcher && this.deps.macroAnalyst) {
          try {
            console.log('[Macro] Refreshing via Apify (legacy)...');
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
      }

      // Calculate regime per pair (BTC as global fallback)
      const pairRegimes = new Map<string, { regime: MarketRegime; confidence: number; profile: FilterProfile }>();
      let marketRegime: MarketRegime = MarketRegime.Range;
      let regimeConfidence = 0;
      let activeProfile: FilterProfile | undefined;

      for (const snap of snapshots) {
        const ind = indicators.get(snap.pair);
        if (ind) {
          const raw = classifyRegime(ind, parseFloat(snap.markPrice), fearGreed);
          const confirmedRegime = this.regimeHysteresis.update(snap.pair, raw.regime);
          pairRegimes.set(snap.pair, {
            regime: confirmedRegime,
            confidence: raw.confidence,
            profile: getFilterProfile(confirmedRegime),
          });
        }
      }
      // Global regime = BTC or first available
      const btcSnap = snapshots.find(s => s.pair === 'BTCUSDT') || snapshots[0];
      const btcRegime = pairRegimes.get(btcSnap?.pair ?? '');
      if (btcRegime) {
        marketRegime = btcRegime.regime;
        regimeConfidence = btcRegime.confidence;
        activeProfile = btcRegime.profile;
      }

      // 5. Drain TradingView signals
      const signals = signalBuffer.drain();

      // 6. LAYER 1: Distill data via experts
      const latestMemoryData = this.deps.memoryKeeper?.read() ?? '';

      let layer1Reports = { macroReport: '', memoryReport: '' };
      try {
        layer1Reports = await runLayer1Experts(this.deps.llm, {
          macroData: JSON.stringify(this.lastMacroAnalysis),
          memoryData: latestMemoryData
        });
      } catch (e: any) {
        console.error('[Loop] Layer1 experts failed entirely:', e.message);
      }

      // 7. CPU Prep: Bundle the distills for the Chief Architect
      const memState = this.deps.memory.load();
      const recentNewsWithAge = this.deps.newsCache.getRecentItems(48);
      const sessionPnlPct = startBalance > 0 ? (sessionPnl / startBalance) * 100 : 0;
      const lossPct = Math.abs(Math.min(sessionPnlPct, 0));
      const riskStatus = lossPct >= 10 ? 'critical' : lossPct >= 5 ? 'reduced' : 'normal';
      const memoryContent = this.deps.memoryKeeper?.read() ?? this.deps.getSoulContent?.();

      let ragContext: string | undefined;
      if (this.deps.episodicAgent) {
        const btcIndForRag = indicators.get('BTCUSDT') || indicators.values().next().value;
        const trendForRag = btcIndForRag ? btcIndForRag.trend : 'neutral';
        const volForRag = btcIndForRag ? btcIndForRag.volumeRatio.toFixed(1) : '1.0';
        const currentStateStr = `Market Regime: ${marketRegime}. Trend: ${trendForRag}. Volatility: ${volForRag}. Risk Environment: ${this.lastMacroAnalysis?.risk_environment || 'neutral'}. Fear & Greed: ${fearGreed.label}`;
        ragContext = await this.deps.episodicAgent.getRelevantContext(currentStateStr);
      }

      // Fetch SL/TP + entry thesis for open positions from DB
      let positionContexts: import('./db/repository.js').OpenPositionContext[] = [];
      if (this.deps.sessionId && portfolio.positions.length > 0) {
        try {
          positionContexts = await getOpenPositionContexts(portfolio.positions.map(p => p.pair));
        } catch (e: any) {
          console.error('[Loop] Failed to fetch position contexts:', e.message);
        }
      }

      // Fetch recent decisions for LLM context (avoid repeating failures)
      let recentDecisions: import('./db/repository.js').RecentDecision[] = [];
      try {
        recentDecisions = await getRecentDecisions(3);
      } catch { /* DB optional */ }

      // Build watchdog summary from recent market snapshots
      let watchdogSummary: string | undefined;
      if (this.deps.sessionId) {
        try {
          const summaryLines: string[] = [];
          for (const pair of this.deps.pairs) {
            const snaps = await getMarketSnapshotsSince(pair, 10);
            const posCtx = positionContexts.find(c => c.pair === pair);
            summaryLines.push(buildWatchdogSummary(pair, snaps, posCtx));
          }
          if (summaryLines.some(l => !l.endsWith('no data since last Brain cycle'))) {
            watchdogSummary = summaryLines.join('\n');
          }
        } catch (e: any) {
          console.error('[Loop] Watchdog summary failed:', e.message);
        }
      }

      // Fetch recent liquidations
      let liquidations: import('./db/types.js').DbLiquidation[] = [];
      try {
        for (const pair of this.deps.pairs) {
          const pairLiqs = await getRecentLiquidations(pair, 15);
          liquidations.push(...pairLiqs);
        }
      } catch { /* DB optional */ }

      // Pre-flight check: calculate soft filter warnings instead of skipping
      let filterWarning: string | undefined = undefined;

      // Per-pair confluence
      const pairConfluence = new Map<string, { score: number; factors: string[] }>();
      const btcInd = indicators.get(btcSnap?.pair ?? '');
      for (const snap of snapshots) {
        const ind = indicators.get(snap.pair);
        const pairProfile = pairRegimes.get(snap.pair)?.profile;
        if (ind) {
          const hasNewsCatalyst = !!(newsAnalysis && Array.isArray((newsAnalysis as any).top_signals) && (newsAnalysis as any).top_signals.some((s: any) => s.importance >= 7));
          pairConfluence.set(snap.pair, computeConfluence({
            trend: ind.trend,
            volumeRatio: ind.volumeRatio,
            vwap: ind.vwap || 0,
            markPrice: parseFloat(snap.markPrice),
            rsi: ind.rsi,
            rsiRange: pairProfile ? [pairProfile.rsiRange?.[0] ?? 30, pairProfile.rsiRange?.[1] ?? 70] : [30, 70],
            hasNewsCatalyst,
          }));
        }
      }
      // BTC confluence for backwards compat (filter warnings, performance log)
      let confluenceResult = pairConfluence.get(btcSnap?.pair ?? '');

      if (activeProfile && btcInd && portfolio.positions.length === 0 && confluenceResult) {
        if (btcInd.volumeRatio < activeProfile.volumeMin) {
          filterWarning = `Volume ${btcInd.volumeRatio.toFixed(2)}x < ${activeProfile.volumeMin}x required for ${marketRegime}`;
        } else if (confluenceResult.score < activeProfile.confluenceMin) {
          filterWarning = `Confluence ${confluenceResult.score}/5 [${confluenceResult.factors.join(',')}] < ${activeProfile.confluenceMin} required for ${marketRegime}`;
        }
      }

      // Pre-LLM screening: filter pairs algorithmically
      const openPairSet = new Set(portfolio.positions.map(p => p.pair));
      let screenResult: ScreenAllResult | undefined;
      let filteredSnapshots = snapshots;

      if (this.deps.preScreener) {
        const screenInputs = snapshots.map(snap => ({
          pair: snap.pair,
          ind1h: indicators.get(snap.pair) ?? null,
          ind4h: indicators4h.get(snap.pair) ?? null,
          regime: pairRegimes.get(snap.pair)?.regime ?? marketRegime,
          confluence: pairConfluence.get(snap.pair)?.score ?? 0,
          hasPosition: openPairSet.has(snap.pair),
        }));
        // Compute current beta-adjusted exposure to skip new positions if already maxed
        const getBeta = (pair: string) => BETA_TO_BTC[pair] ?? 1.0;
        let longExp = 0, shortExp = 0;
        for (const p of portfolio.positions) {
          const margin = p.sizeUsd / p.leverage;
          if (p.side === 'LONG') longExp += margin * getBeta(p.pair);
          else shortExp += margin * getBeta(p.pair);
        }
        const netExp = Math.abs(longExp - shortExp);
        const grossExp = longExp + shortExp;
        const currentExposurePct = (Math.max(netExp, grossExp * 0.5) / portfolio.balanceUsd) * 100;
        const maxExposurePct = this.deps.tradingConfig.maxExposurePct ?? 150;
        const exposureFull = currentExposurePct >= maxExposurePct;
        if (exposureFull) {
          console.log(`[PreScreen] Exposure ${currentExposurePct.toFixed(1)}% >= max ${maxExposurePct}% — skipping new positions`);
        }
        screenResult = this.deps.preScreener.screenAll(screenInputs, {
          exposureFull,
          margin: {
            availableUsd: portfolio.availableUsd ?? portfolio.balanceUsd,
            walletBalanceUsd: portfolio.balanceUsd,
            minPositionUsd: 6,
          },
        });

        const passedPairs = new Set(screenResult.passed.map(v => v.pair));
        filteredSnapshots = snapshots.filter(s => passedPairs.has(s.pair));

        if (screenResult.held.length > 0) {
          const heldSummary = screenResult.held.map(h => `${h.pair}:${h.reason}`).join(', ');
          console.log(`[PreScreen] ${screenResult.held.length} pairs auto-HOLD: ${heldSummary}`);
          console.log(`[PreScreen] ${filteredSnapshots.length}/${snapshots.length} pairs sent to LLM`);
        }
        if (screenResult.marginMode !== 'normal') {
          console.log(`[PreScreen] Margin mode: ${screenResult.marginMode} (available: $${(portfolio.availableUsd ?? portfolio.balanceUsd).toFixed(2)})`);
        }
      }

      // Pair diversity context
      const diversityContext = buildDiversityContext(
        this.pairDecisionHistory,
        this.deps.pairs,
        this.cycleCount,
      );

      // Decision envelope — precomputed risk bounds for LLM
      const isWeekendNow = [0, 6].includes(new Date().getUTCDay());
      const envelope = riskManager.computeEnvelope(portfolio, {
        fearGreed: fearGreed ?? undefined,
        fearGreedLeverageCap: this.deps.tradingConfig.fearGreedLeverageCap,
        isWeekend: isWeekendNow,
        weekendLeverageMultiplier: this.deps.tradingConfig.weekendLeverageMultiplier,
        regimeLeverageMultiplier: activeProfile?.leverageMultiplier,
      });

      // Low margin: double leverage to compensate small position size
      if (screenResult?.marginMode === 'low_margin' && envelope) {
        envelope.maxLeverage = Math.min(envelope.maxLeverage * 2, this.deps.tradingConfig.maxLeverage);
        envelope.recommendedLeverage = [
          envelope.recommendedLeverage[0] * 2,
          Math.min(envelope.recommendedLeverage[1] * 2, envelope.maxLeverage),
        ];
        console.log(`[PreScreen] Low margin — leverage doubled: max ${envelope.maxLeverage}x`);
      }

      // Today's realized PnL
      let todayRealizedPnl = 0;
      try {
        todayRealizedPnl = await (this.deps.marketData as any).getTodayRealizedPnl();
      } catch { /* optional */ }

      const promptData = {
        snapshots: filteredSnapshots,
        indicators,
        indicators4h,
        portfolio,
        signals,
        news: [],
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        newsAnalysis,
        newsAnalyzedAt,
        recentNewsWithAge,
        macroAnalysis: this.lastMacroAnalysis,
        sessionPnlPct,
        lastOrderResult: this.deps.memory.getLastOrderResult(),
        riskStatus,
        staticSoul: this.getStaticSoul(),
        memoryContent,
        regime: marketRegime,
        pairRegimes: Object.fromEntries([...pairRegimes.entries()].map(([k, v]) => [k, { regime: v.regime, confidence: v.confidence }])),
        pairConfluence: Object.fromEntries(pairConfluence),
        layer1Reports, // NEW INJECTION
        ragContext,
        filterWarning,
        positionContexts,
        watchdogSummary,
        recentDecisions,
        pairDiversityContext: diversityContext,
        todayRealizedPnl,
        envelope,
        liquidations: liquidations.length > 0 ? liquidations : undefined,
        newsMarketFusion: this.lastNewsMarketFusion,
        sessionBlock: formatSessionPromptBlock(new Date()),
        screenedOutPairs: screenResult?.held.map(h => ({ pair: h.pair, reason: h.reason ?? 'unknown' })),
        marginMode: screenResult?.marginMode,
      };

      let decisions: TradeDecision[] = [];
      let currentLayer: 1 | 2 | 3 = 1;

      // Insert cycle early so swarm/LLM get a cycleId for conversation tracking
      let cycleId: number | undefined;
      if (this.deps.sessionId) {
        try {
          cycleId = await insertCycle({
            session_id: this.deps.sessionId,
            cycle_number: this.cycleCount,
            balance: portfolio.balanceUsd,
            session_pnl: sessionPnl,
            open_positions: portfolio.positions.map(p => ({ pair: p.pair, side: p.side, sizeUsd: p.sizeUsd, pnlPct: p.unrealizedPnlPct })),
            volume_ratio: btcInd?.volumeRatio,
            confluence_score: confluenceResult?.score,
            confluence_factors: confluenceResult?.factors,
            regime: marketRegime,
            regime_confidence: regimeConfidence,
            fear_greed_value: fearGreed?.value,
            layer: currentLayer,
            filter_warning: filterWarning,
          });
          logger.cycleId = cycleId ?? null;
          if (cycleId) {
            this.deps.llm.cycleId = cycleId;
            if (this.deps.fallbackLlm) (this.deps.fallbackLlm as any).cycleId = cycleId;
            if (this.deps.swarmAgent) (this.deps.swarmAgent as any).cycleId = cycleId;
          }
        } catch (err: any) {
          console.error('[DB] Failed to insert cycle:', err.message);
        }
      }

      let useSwarm = false;
      try {
        if (filterWarning) {
          console.log(`[Loop] Pre-flight warning: ${filterWarning} (Passing to LLM as Soft Filter)`);

        }
        if (this.deps.swarmAgent && btcInd) {
          const btcSnapTemp = snapshots.find(s => s.pair === 'BTCUSDT');
          if (btcSnapTemp) {
            const btcIndTemp = indicators.get(btcSnapTemp.pair);
            if (btcIndTemp && btcIndTemp.volumeRatio > (this.deps.tradingConfig.swarmVolumeThreshold ?? 0.8)) {
              useSwarm = true;
            }
          }
        }

        if (useSwarm && this.deps.swarmAgent) {
          console.log(`[Loop] High Volatility (Vol=${btcInd?.volumeRatio.toFixed(1)}x) -> Engaging SWARM CONSENSUS`);
          decisions = await this.deps.swarmAgent.getConsensus(promptData);
        } else {
          decisions = await llm.analyze(promptData);
        }
      } catch (llmErr: any) {
        console.error('[Loop] Layer 1 (Codex API) failed:', llmErr?.message);
        logger.logError('LLM_LAYER1_FAILED', llmErr?.message ?? 'unknown');

        if (this.deps.fallbackLlm) {
          try {
            decisions = await this.deps.fallbackLlm.analyze(
              portfolio.positions,
              sessionPnlPct,
              memoryContent,
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

      // Merge auto-HOLD decisions from pre-screener
      if (screenResult?.held.length) {
        for (const held of screenResult.held) {
          decisions.push({
            pair: held.pair,
            action: 'HOLD',
            size_pct: 0,
            leverage: 0,
            stop_loss_pct: 0,
            take_profit_pct: 0,
            reasoning: held.reason ?? 'pre_screen',
            confidence: 0,
          });
        }
      }

      // Layer 3: if significant loss and positions open — read Big Brother + emergency close
      const layer3Threshold = this.deps.tradingConfig.layer3EmergencyPct ?? -5;
      if (currentLayer === 3 && portfolio.positions.length > 0 && sessionPnlPct < layer3Threshold) {
        if (memoryContent) {
          const insights = extractExternalInsights(memoryContent);
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
      if (hasPositions && (nextCheckMinutes === undefined || nextCheckMinutes < 10)) {
        nextCheckMinutes = 10;
      } else if (!hasPositions && (nextCheckMinutes === undefined || nextCheckMinutes < 30)) {
        nextCheckMinutes = 30;
      }

      // No margin: slow down to 60-min cycles
      if (screenResult?.marginMode === 'no_margin' && !hasPositions && (nextCheckMinutes === undefined || nextCheckMinutes < 60)) {
        nextCheckMinutes = 60;
        console.log(`[PreScreen] No margin — cycle floor 60 min`);
      }

      // Safety guard: in Layer 2/3, filter out any LONG/SHORT decisions
      if (currentLayer >= 2) {
        decisions = decisions.filter(d => d.action === 'HOLD' || d.action === 'CLOSE');
      }

      // regime_override removed — classifier is the single source of truth.
      // LLM controls actions/confidence/sizing, not system filters.

      // Save indicator snapshots to DB
      if (cycleId) {
        for (const [pair, ind] of indicators.entries()) {
          insertIndicatorSnapshot({
            cycle_id: cycleId, pair, timeframe: '1h',
            rsi: ind.rsi, ema_short: ind.ema20, ema_long: ind.ema50,
            macd: ind.macd, macd_signal: ind.macdSignal, macd_histogram: ind.macdHistogram,
            adx: ind.adx, atr: ind.atr,
            vwap: ind.vwap,
            bb_upper: ind.bollingerUpper, bb_lower: ind.bollingerLower, bb_width: ind.bollingerBandwidth,
            volume_ratio: ind.volumeRatio, trend: ind.trend,
          }).catch(e => console.error('[DB] indicator snapshot error:', e.message));
        }
        for (const [pair, ind] of indicators4h.entries()) {
          insertIndicatorSnapshot({
            cycle_id: cycleId, pair, timeframe: '4h',
            rsi: ind.rsi, ema_short: ind.ema20, ema_long: ind.ema50,
            macd: ind.macd, macd_signal: ind.macdSignal, macd_histogram: ind.macdHistogram,
            adx: ind.adx, atr: ind.atr,
            vwap: ind.vwap,
            bb_upper: ind.bollingerUpper, bb_lower: ind.bollingerLower, bb_width: ind.bollingerBandwidth,
            volume_ratio: ind.volumeRatio, trend: ind.trend,
          }).catch(e => console.error('[DB] indicator snapshot error:', e.message));
        }
      }

      // 5. Process each decision
      for (const decision of decisions) {
        logger.logDecision({
          type: 'LLM_DECISION',
          ...decision,
          portfolio: { balance: portfolio.balanceUsd, sessionPnl },
        });

        // Write to Decision Journal
        if (this.deps.decisionJournal) {
          const entry: JournalEntry = {
            pair: decision.pair,
            regime: marketRegime,
            regimeConfidence: regimeConfidence,
            regimeOverride: null,
            filtersApplied: {
              volume: {
                value: indicators.get(decision.pair)?.volumeRatio,
                min: activeProfile?.volumeMin,
                passed: true,
              }
            },
            action: decision.action,
            reasoning: decision.reasoning,
            confidence: decision.confidence ?? 50,
            riskValidation: 'PENDING',
            indicatorsSnapshot: {
              rsi: indicators.get(decision.pair)?.rsi ?? 0,
              adx: indicators.get(decision.pair)?.adx ?? 0,
            },
            session: getMarketSession(new Date()),
            sessionPatternActive: decision.session_context?.session_pattern_active,
            sessionFitScore: decision.session_context?.session_fit_score,
            sessionRole: decision.session_context?.session_role,
            sessionReason: decision.session_context?.session_reason,
          };
          this.deps.decisionJournal.log(entry);
        }

        if (decision.action === 'FETCH_NEWS') {
          console.log(`[News] LLM requested refresh: ${decision.reasoning}`);
          const newsSource = this.deps.rssFetcher || this.deps.newsClient;
          if (newsSource) {
            const items = await newsSource.fetchNews(this.deps.newsConfig.maxItems);

            // Track source health for RSS feeds
            if (this.deps.sourceHealth && this.deps.rssFetcher) {
              const sources = [...new Set(items.map(i => i.source))];
              for (const s of sources) this.deps.sourceHealth.recordSuccess(s);
            }

            const analysis = await this.deps.newsAnalyst.analyze(items);

              await this.runGroundingAndFusion(analysis);

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

        // Volatility Targeting (VT) Size Cap
        if (decision.action === 'LONG' || decision.action === 'SHORT') {
          const targetRiskPct = (this.deps.tradingConfig as any).targetRiskPct ?? 2;
          const slDistancePct = decision.stop_loss_pct;
          if (slDistancePct && slDistancePct > 0) {
            const maxVtSize = (portfolio.balanceUsd * (targetRiskPct / 100)) / (slDistancePct / 100);
            const maxVtSizePct = (maxVtSize / portfolio.balanceUsd) * 100;
            if (decision.size_pct > maxVtSizePct) {
              console.log(`[VT Sizing] Capping ${decision.pair} from ${decision.size_pct}% to ${maxVtSizePct.toFixed(1)}% due to Volatility Targeting (Risk: ${targetRiskPct}%, SL: ${slDistancePct}%)`);
              decision.size_pct = Math.round(maxVtSizePct);
            }
          }
        }

        // 6. Risk check
        const validationCtx = {
          indicators4h: indicators4h.size > 0 ? indicators4h as Map<string, { trend: string }> : undefined,
          indicators1h: indicators.size > 0 ? indicators as Map<string, { atr: number; trend: string }> : undefined,
          fearGreed,
          fearGreedLeverageCap: this.deps.tradingConfig.fearGreedLeverageCap,
        };
        // Build ADJUST context if needed
        let adjustCtx: AdjustContext | undefined;
        if (decision.action === 'ADJUST') {
          const posCtx = positionContexts.find(c => c.pair === decision.pair);
          const pos = portfolio.positions.find(p => p.pair === decision.pair);
          if (posCtx && pos) {
            adjustCtx = {
              currentSlPrice: Number(posCtx.sl_price),
              currentTpPrice: Number(posCtx.tp_price),
              entryPrice: Number(posCtx.fill_price),
              side: pos.side,
            };
          }
        }
        // Build spread context for this pair
        const pairSpreadHistory = this.spreadHistory.get(decision.pair) ?? [];
        const pairSnap = snapshots.find(s => s.pair === decision.pair);
        let medianSpreadPct: number | undefined;
        if (pairSpreadHistory.length > 0) {
          const sorted = [...pairSpreadHistory].sort((a, b) => a - b);
          medianSpreadPct = sorted[Math.floor(sorted.length / 2)];
        }

        const validation = riskManager.validate(decision, portfolio, validationCtx, adjustCtx, {
          dailyRealizedPnl: todayRealizedPnl,
          spreadPct: pairSnap?.spreadPct,
          medianSpreadPct,
          spreadSampleSize: pairSpreadHistory.length,
        });

        // Save trade decision + risk validation to DB
        let decisionId: number | undefined;
        if (cycleId && decision.pair) {
          try {
            decisionId = await insertTradeDecision({
              cycle_id: cycleId,
              pair: decision.pair,
              action: decision.action,
              size_pct: decision.size_pct,
              leverage: decision.leverage,
              stop_loss_pct: decision.stop_loss_pct,
              take_profit_pct: decision.take_profit_pct,
              confidence: decision.confidence,
              reasoning: decision.reasoning,
              regime: marketRegime,
              regime_confidence: regimeConfidence,
              regime_override: undefined,
              volume_ratio: btcInd?.volumeRatio,
              confluence_score: confluenceResult?.score,
              confluence_factors: confluenceResult?.factors,
              session: getMarketSession(new Date()),
              session_pattern_active: decision.session_context?.session_pattern_active,
              session_fit_score: decision.session_context?.session_fit_score,
              session_role: decision.session_context?.session_role,
              session_reason: decision.session_context?.session_reason,
            });
            insertRiskValidation({
              decision_id: decisionId,
              passed: validation.approved,
              rejection_reason: validation.reason,
              shutdown_triggered: validation.shutdown,
            }).catch(() => {});
          } catch (e: any) {
            console.error('[DB] decision insert error:', e.message);
          }
        }

        if (!validation.approved) {
          logger.logDecision({ type: 'RISK_REJECTED', pair: decision.pair, reason: validation.reason });
          this.deps.memoryKeeper?.addRejection({
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
            // Min hold time: don't close positions held < 10 minutes
            // NaN guard: undefined heldHours → 0 (block close)
            const minHoldMinutes = 10;
            const heldMinutes = pos.heldHours ? pos.heldHours * 60 : 0;
            if (heldMinutes < minHoldMinutes) {
              console.log(`[HoldLock] Blocking CLOSE on ${decision.pair} — held ${heldMinutes.toFixed(0)}m < ${minHoldMinutes}m minimum`);
              continue;
            }
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

              // Save trade close to DB
              if (cycleId) {
                const posCtxForClose = positionContexts.find(c => c.pair === decision.pair);
                insertTradeClose({
                  execution_id: posCtxForClose?.id,
                  pair: decision.pair,
                  exit_reason: 'llm_close',
                  pnl_usd: parseFloat(pnlUsd.toFixed(2)),
                  pnl_pct: pos.unrealizedPnlPct,
                  held_hours: pos.heldHours,
                  order_id: result.orderId,
                  close_decision_id: decisionId,
                  regime_at_exit: pairRegimes.get(decision.pair)?.regime ?? marketRegime,
                  holding_time_minutes: pos.heldHours * 60,
                }).catch(e => console.error('[DB] close insert error:', e.message));
              }

              if (this.deps.tradeStoryLogger) {
                this.deps.tradeStoryLogger.log({
                  pair: decision.pair,
                  direction: pos.side,
                  entryTime: new Date(Date.now() - pos.heldHours * 3600000).toISOString(),
                  exitTime: new Date().toISOString(),
                  entryPrice: pos.entryPrice,
                  exitPrice: typeof result.fillPrice === 'number' ? result.fillPrice : pos.entryPrice,
                  pnlPct: pos.unrealizedPnlPct,
                  regimeAtEntry: 'unknown',
                  regimeAtExit: marketRegime,
                  story: `Closed position by LLM decision: ${decision.reasoning}`,
                  lesson: 'LLM managed exit'
                });
              }
              this.saveEpisode(decision.pair, pos.side, marketRegime, indicators, pos.heldHours, pos.unrealizedPnlPct, decision.reasoning);
            } else {
              logger.logError('ORDER_FAIL', result.error || 'Unknown error');
            }
          }
        } else if (decision.action === 'ADJUST') {
          const pos = portfolio.positions.find(p => p.pair === decision.pair);
          const posCtx = positionContexts.find(c => c.pair === decision.pair);
          if (!pos || !posCtx) {
            console.log(`[Adjust] No open position or context for ${decision.pair} — skipping`);
            continue;
          }

          const entryPrice = Number(posCtx.fill_price);
          const newSlPrice = pos.side === 'LONG'
            ? entryPrice * (1 - decision.stop_loss_pct / 100)
            : entryPrice * (1 + decision.stop_loss_pct / 100);
          const newTpPrice = pos.side === 'LONG'
            ? entryPrice * (1 + decision.take_profit_pct / 100)
            : entryPrice * (1 - decision.take_profit_pct / 100);

          const result = await orders.adjustSlTp({
            pair: decision.pair,
            side: pos.side,
            newSlPrice,
            newTpPrice,
          });

          if (result.success) {
            const oldSl = Number(posCtx.sl_price);
            const oldTp = Number(posCtx.tp_price);
            console.log(`[Adjust] ${decision.pair}: SL $${oldSl.toFixed(4)}→$${newSlPrice.toFixed(4)}, TP $${oldTp.toFixed(4)}→$${newTpPrice.toFixed(4)}`);

            // Update execution record so next cycle sees current SL/TP
            if (posCtx.id) {
              updateExecutionSlTp(posCtx.id, newSlPrice, newTpPrice).catch(() => {});
            }

            // Log adjustment to DB
            if (cycleId) {
              insertSlTpAdjustment({
                cycle_id: cycleId,
                execution_id: posCtx.id,
                pair: decision.pair,
                side: pos.side,
                old_sl: oldSl,
                new_sl: newSlPrice,
                old_tp: oldTp,
                new_tp: newTpPrice,
                reasoning: decision.reasoning,
              }).catch(() => {});
            }

            this.deps.memory.setLastOrderResult(
              `${decision.pair} ADJUST — SL→$${newSlPrice.toFixed(4)}, TP→$${newTpPrice.toFixed(4)}: ${decision.reasoning}`
            );
          } else {
            console.error(`[Adjust] Failed for ${decision.pair}: ${result.error}`);
            logger.logError('ADJUST_FAIL', result.error || 'Unknown');
          }
        } else {
          const lastClose = this.lastClosedAt.get(decision.pair);
          if (lastClose && Date.now() - lastClose < this.deps.churnCooldownMs) {
            const remainingMin = Math.round((this.deps.churnCooldownMs - (Date.now() - lastClose)) / 60000);
            console.log(`[Churn] Skipping ${decision.pair} ${decision.action} — cooldown ${remainingMin}m remaining`);
            continue;
          }
          // Apply Leverage Multiplier per Filter Profile BEFORE order execution
          const decisionProfile = pairRegimes.get(decision.pair)?.profile ?? activeProfile;
          if (decisionProfile && (decision.action === 'LONG' || decision.action === 'SHORT')) {
            const minLev = this.deps.tradingConfig.minLeverage ?? 1;
            decision.leverage = Math.max(minLev, Math.round(decision.leverage * decisionProfile.leverageMultiplier));
            const decisionRegime = pairRegimes.get(decision.pair)?.regime ?? marketRegime;
            console.log(`[Regime] Adjusted leverage for ${decision.pair} to ${decision.leverage}x based on ${decisionRegime} profile`);
          }

          // Weekend leverage reduction
          if (decision.action === 'LONG' || decision.action === 'SHORT') {
            const isWeekend = [0, 6].includes(new Date().getUTCDay());
            if (isWeekend) {
              const weekendMult = this.deps.tradingConfig.weekendLeverageMultiplier ?? 0.5;
              const wkMinLev = this.deps.tradingConfig.minLeverage ?? 1;
              decision.leverage = Math.max(wkMinLev, Math.round(decision.leverage * weekendMult));
              console.log(`[Weekend] Reduced ${decision.pair} leverage to ${decision.leverage}x`);
            }
          }

          // Regime-aware SL/TP adjustment
          if (decision.action === 'LONG' || decision.action === 'SHORT') {
            const pairProfile = pairRegimes.get(decision.pair);
            const pairInd = indicators.get(decision.pair);
            if (pairProfile?.profile && pairInd) {
              const { computeSlTpPrices } = await import('./market/sl-tp-styles.js');
              const snap = snapshots.find(s => s.pair === decision.pair);
              const currentPrice = snap ? parseFloat(snap.markPrice) : 0;
              if (currentPrice > 0) {
                const adjusted = computeSlTpPrices({
                  slStyle: pairProfile.profile.slStyle || 'fixed',
                  tpStyle: pairProfile.profile.tpStyle || 'fixed',
                  slPct: decision.stop_loss_pct,
                  tpPct: decision.take_profit_pct,
                  fillPrice: currentPrice,
                  side: decision.action as 'LONG' | 'SHORT',
                  indicators: pairInd,
                });
                decision.stop_loss_pct = Math.abs((adjusted.slPrice - currentPrice) / currentPrice * 100);
                decision.take_profit_pct = Math.abs((adjusted.tpPrice - currentPrice) / currentPrice * 100);
              }
            }
          }

          // Cap TP/SL to scalping limits if in Scalping regime
          const decisionRegimeForCap = pairRegimes.get(decision.pair)?.regime ?? marketRegime;
          if (decisionRegimeForCap === MarketRegime.Scalping) {
            const scalping = this.deps.tradingConfig as any;
            decision.take_profit_pct = Math.min(decision.take_profit_pct, scalping.scalpingMinTakeProfitPct ?? 1.0);
            decision.stop_loss_pct = Math.min(decision.stop_loss_pct, scalping.scalpingMaxStopLossPct ?? 0.8);
            console.log(`[Scalping] Capped ${decision.pair} TP=${decision.take_profit_pct.toFixed(2)}% SL=${decision.stop_loss_pct.toFixed(2)}%`);
          }

          const result = await orders.execute(decision, portfolio.balanceUsd);

          if (result.success) {
            // Track pair decision for diversity context
            this.pairDecisionHistory.push({ pair: decision.pair, cycle: this.cycleCount });
            if (this.pairDecisionHistory.length > 50) {
              this.pairDecisionHistory = this.pairDecisionHistory.slice(-50);
            }

            logger.logTrade({
              type: decision.action,
              pair: decision.pair,
              size_pct: decision.size_pct,
              leverage: decision.leverage,
              orderId: result.orderId,
            });

            // Save trade execution to DB
            if (cycleId && decisionId) {
              const pairRegime = pairRegimes.get(decision.pair);
              const entryRegime = pairRegime?.regime ?? marketRegime ?? 'Range';
              const entryConfidence = pairRegime?.confidence ?? regimeConfidence ?? 0;
              const entryConfluence = pairConfluence.get(decision.pair)?.score ?? confluenceResult?.score;
              const entryVolumeRatio = btcInd?.volumeRatio ?? null;
              const entryFearGreed = fearGreed?.value ?? null;
              console.log(`[DB] Execution metadata: regime=${entryRegime} conf=${entryConfidence} fg=${entryFearGreed} vol=${entryVolumeRatio} confluence=${entryConfluence}`);
              insertTradeExecution({
                decision_id: decisionId,
                pair: decision.pair,
                side: decision.action === 'LONG' ? 'BUY' : 'SELL',
                action: decision.action,
                leverage: decision.leverage,
                order_id: result.orderId,
                size_usd: (decision.size_pct / 100) * portfolio.balanceUsd,
                fill_price: result.fillPrice,
                sl_price: result.slPrice,
                tp_price: result.tpPrice,
                quantity: result.quantity,
                entry_price: result.fillPrice,
                entry_thesis: decision.reasoning,
                strategy_type: entryRegime === MarketRegime.Scalping ? 'scalping' : 'swing',
                commission_usd: result.commissionUsd,
                commission_asset: result.commissionAsset,
                regime_at_entry: entryRegime,
                regime_confidence_at_entry: entryConfidence,
                filter_profile_at_entry: entryRegime,
                confluence_at_entry: entryConfluence,
                was_swarm: currentLayer === 1 && useSwarm,
                volume_ratio_at_entry: entryVolumeRatio ?? undefined,
                fear_greed_at_entry: entryFearGreed,
              }).catch(e => console.error('[DB] execution insert error:', e.message));
            }

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

      // Refresh TP1 targets for watchdog (all open positions with TP price)
      if (this.deps.watchdog && this.deps.positionManagement?.enabled) {
        try {
          const openPairs = portfolio.positions.map(p => p.pair);
          if (openPairs.length > 0) {
            const posCtxs = await getOpenPositionContexts(openPairs);
            const targets: Tp1Target[] = posCtxs
              .filter(ctx => ctx.tp_price && ctx.fill_price && ctx.id)
              .map(ctx => ({
                pair: ctx.pair,
                side: (ctx.side === 'BUY' ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
                entryPrice: ctx.fill_price,
                tpPrice: ctx.tp_price,
                executionId: ctx.id,
              }));
            this.deps.watchdog.setTp1Targets(targets);
          }
        } catch { /* DB optional */ }
      }

      logger.logPerformance({
        balance: portfolio.balanceUsd,
        openPositions: portfolio.positions.length,
        sessionPnl,
        cycleCount: this.cycleCount,
        volumeRatio: btcInd?.volumeRatio,
        confluence: confluenceResult?.score,
        confluenceFactors: confluenceResult?.factors,
        regime: marketRegime,
        preScreen: screenResult ? {
          total: screenResult.passed.length + screenResult.held.length,
          passed: screenResult.passed.length,
          held: screenResult.held.length,
          heldReasons: screenResult.held.reduce((acc, h) => {
            acc[h.reason ?? 'unknown'] = (acc[h.reason ?? 'unknown'] ?? 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        } : undefined,
      });
      this.cycleCount++;

      // Update soul stats
      if (this.deps.memoryKeeper) {
        const stats = computeMemoryStats(
          this.deps.memory.load().recent_trades,
          sessionPnlPct,
        );
        this.deps.memoryKeeper.updateStats(stats);
      }

      if (nextCheckMinutes) {
        console.log(`[Loop] Next cycle in ${nextCheckMinutes} min${hasPositions ? ' (positions open — capped)' : ''}`);
      }

      // Soul review (LLM self-reflection)
      if (this.deps.memoryReview) {
        const streak = this.deps.memory.load().recent_trades.reduce((s, t) => {
          if (s === null) return t.pnlPct < 0 ? -1 : t.pnlPct > 0 ? 1 : 0;
          if (s > 0 && t.pnlPct > 0) return s + 1;
          if (s < 0 && t.pnlPct < 0) return s - 1;
          return null;
        }, null as number | null) ?? 0;
        const consecutiveLosses = streak < 0 ? Math.abs(streak) : 0;
        if (this.deps.memoryReview.shouldReview(this.cycleCount, consecutiveLosses, sessionPnlPct)) {
          try {
            let recentDecisionStrings: string[] = [];
            if (this.deps.sessionId) {
              try {
                const { getRecentDecisionsBySession } = await import('./db/repository.js');
                const rows = await getRecentDecisionsBySession(this.deps.sessionId, 20);
                recentDecisionStrings = rows.map((d: any) =>
                  `${d.pair} ${d.action} (conf:${d.confidence}) — ${(d.reasoning ?? '').slice(0, 100)}`
                );
              } catch { /* DB optional */ }
            }
            await this.deps.memoryReview.review(
              this.deps.memory.load().recent_trades,
              recentDecisionStrings,
              this.cycleCount,
            );
          } catch (err) {
            console.error('[MemoryReview] Error:', err);
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
