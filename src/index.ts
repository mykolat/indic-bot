import 'dotenv/config';
if (process.env.GLOBAL_AGENT_HTTPS_PROXY) {
  const { bootstrap } = await import('global-agent');
  bootstrap();
}
import { loadConfig } from './config.js';
import { createBinanceClient } from './binance/client.js';
import { MarketDataFetcher } from './binance/market-data.js';
import { OrderExecutor, computeDecimalsFromStep } from './binance/orders.js';
import { LLMClient } from './llm/client.js';
import { FallbackLLMClient } from './llm/fallback-client.js';
import { getOpenAIAccessToken } from './llm/oauth.js';
import { RiskManager } from './risk/manager.js';
import { SignalBuffer } from './webhook/signal-buffer.js';
import { createWebhookServer } from './webhook/server.js';
import { TradingLoop } from './trading-loop.js';
import { Logger } from './logger/index.js';
import { CryptoPanicClient } from './news/cryptopanic.js';
import { NewsCache } from './news/news-cache.js';
import { NewsAnalystAgent } from './news/news-analyst.js';
import { SessionMemory } from './memory/session.js';
import { MacroFetcher } from './news/macro-fetcher.js';
import { MacroAnalystAgent } from './news/macro-analyst.js';
import { join } from 'path';
import { MemoryKeeper } from './memory/memory-keeper.js';
import { SwarmAgent } from './llm/swarm-agent.js';
import { MemoryReviewAgent } from './memory/memory-review.js';
import { RssNewsFetcher } from './news/rss-fetcher.js';
import { GrokGrounder } from './news/grok-grounder.js';
import { SourceHealthMonitor } from './news/source-health.js';
import { EmbeddingClient } from './llm/embedding-client.js';
import { EpisodicStore } from './memory/episodic-store.js';
import { EpisodicAgent } from './llm/episodic-agent.js';
import { DecisionJournal } from './logging/decision-journal.js';
import { TradeStoryLogger } from './logging/trade-story.js';
import { FlashCrashScanner } from './news/flash-crash.js';
import { GrokClient } from './llm/grok-client.js';
import { initPool, closePool } from './db/connection.js';
import { insertSession, insertMarketSnapshot, getLatestMarketSnapshot } from './db/repository.js';
import { Watchdog } from './watchdog.js';

async function main() {
  const config = loadConfig();
  const logger = new Logger('logs');

  // Initialize database if configured
  let sessionId: string | undefined;
  if (config.database.url) {
    initPool(config.database.url);
    console.log('[DB] PostgreSQL pool initialized');
    try {
      const yamlConfigSnapshot = { ...config.trading, pairs: config.trading.pairs };
      sessionId = await insertSession({ start_balance: 0, config: yamlConfigSnapshot });
      console.log(`[DB] Session started: ${sessionId}`);
    } catch (err: any) {
      console.error('[DB] Failed to create session:', err.message);
    }
  } else {
    console.log('[DB] No DATABASE_URL — running without observability DB');
  }

  const memory = new SessionMemory();
  const memState = memory.load();
  if (memState.session_notes) {
    console.log('[Memory] Loaded session notes from prior session');
  }

  console.log('=== AI Futures Trading Bot ===');
  console.log(`Pairs: ${config.trading.pairs.join(', ')}`);
  console.log(`Max leverage: ${config.trading.maxLeverage}x`);
  console.log(`Loop interval: ${config.trading.loopIntervalMs / 1000}s`);
  console.log(`Max loss: $${config.trading.maxLossUsd}`);
  console.log(`Testnet: ${config.binance.testnet}`);
  console.log('==============================\n');

  // Initialize components
  const binanceClient = createBinanceClient(config.binance);
  const marketData = new MarketDataFetcher(binanceClient);

  // Load exchange info for quantity + price precision
  let stepDecimals = new Map<string, number>();
  let priceDecimals = new Map<string, number>();
  try {
    const info = await binanceClient.getExchangeInfo();
    for (const sym of info.symbols) {
      if (config.trading.pairs.includes(sym.symbol)) {
        const lotFilter = sym.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        if (lotFilter?.stepSize) {
          stepDecimals.set(sym.symbol, computeDecimalsFromStep(lotFilter.stepSize));
        }
        const priceFilter = sym.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        if (priceFilter?.tickSize) {
          priceDecimals.set(sym.symbol, computeDecimalsFromStep(priceFilter.tickSize));
        }
      }
    }
    console.log(`[Binance] Loaded precision for ${stepDecimals.size} pairs (qty: stepSize, price: tickSize)`);
  } catch (e: any) {
    console.warn(`[Binance] Failed to load exchangeInfo: ${e.message} — using defaults`);
  }

  const orders = new OrderExecutor(binanceClient, stepDecimals, priceDecimals);

  // OpenAI auth: OAuth (default) or API key fallback
  let accessToken: string;
  if (config.openai.apiKey && config.openai.apiKey !== 'oauth') {
    console.log('[Auth] Using OpenAI API key from env');
    accessToken = config.openai.apiKey;
  } else {
    console.log('[Auth] Using OpenAI OAuth flow...');
    accessToken = await getOpenAIAccessToken();
  }

  const promptConfig = {
    targetReturnPct: config.trading.targetReturnPct,
    minTakeProfitPct: config.trading.minTakeProfitPct,
    maxLeverage: config.trading.maxLeverage,
    maxPositionPct: config.trading.maxPositionPct,
    maxStopLossPct: config.trading.maxStopLossPct,
    pairs: config.trading.pairs,
    minConfidence: config.trading.minConfidence,
    fearGreedLeverageCap: config.trading.fearGreedLeverageCap,
  };
  const llm = new LLMClient(accessToken, config.openai.model, promptConfig);
  if (sessionId) {
    llm.sessionId = sessionId;
  }

  const fallbackLlm = config.openai.apiKeyFallback
    ? new FallbackLLMClient(config.openai.apiKeyFallback, config.openai.fallbackModel)
    : undefined;
  if (fallbackLlm && sessionId) {
    fallbackLlm.sessionId = sessionId;
  }
  if (fallbackLlm) {
    console.log(`[Fallback] Layer 2 enabled — ${config.openai.fallbackModel} (OPENAI_API_KEY_FALLBACK)`);
  } else {
    console.log('[Fallback] No OPENAI_API_KEY_FALLBACK — Layer 3 (rule-based) on Codex failure');
  }

  const memoryKeeper = new MemoryKeeper(join(process.env.HOME || '.', '.indic-bot'));
  const memoryReview = new MemoryReviewAgent({ llm, memoryKeeper });
  if (sessionId) {
    memoryReview.sessionId = sessionId;
  }
  console.log('[Memory] MemoryKeeper + MemoryReview initialized');

  const newsCache = new NewsCache();
  const newsAnalyst = new NewsAnalystAgent(llm);

  const riskManager = new RiskManager({
    maxLeverage: config.trading.maxLeverage,
    maxPositionPct: config.trading.maxPositionPct,
    maxExposurePct: config.trading.maxExposurePct,
    maxStopLossPct: config.trading.maxStopLossPct,
    maxDrawdownPct: config.trading.maxDrawdownPct,
    maxLossUsd: config.trading.maxLossUsd,
    maxLossPct: config.trading.maxLossPct,
    minConfidence: config.trading.minConfidence,
  });

  const signalBuffer = new SignalBuffer({ maxSize: 50, ttlMs: 30 * 60 * 1000 });

  // News client (optional — only if Apify token is provided)
  const newsClient = config.apifyToken
    ? new CryptoPanicClient(config.apifyToken)
    : undefined;
  if (newsClient) console.log('[News] CryptoPanic via Apify enabled');
  else console.log('[News] No APIFY_API_TOKEN — news disabled');

  const macroFetcher = config.apifyToken ? new MacroFetcher(config.apifyToken) : undefined;
  const macroAnalyst = macroFetcher ? new MacroAnalystAgent(llm) : undefined;
  if (macroFetcher) console.log('[Macro] MacroFetcher enabled — refreshing every 3h');
  else console.log('[Macro] No APIFY_API_TOKEN — macro disabled');

  const sourceHealth = new SourceHealthMonitor();

  // Instantiate RSS Fetcher as primary news source if no Apify token, or as supplementary
  const rssFetcher = new RssNewsFetcher();

  // Instantiate Grok Grounder if API key is provided
  const grokGrounder = process.env.XAI_API_KEY ? new GrokGrounder(process.env.XAI_API_KEY) : undefined;
  if (grokGrounder) console.log('[Grok] xAI Grounder enabled for claim verification');
  else console.log('[Grok] No XAI_API_KEY — claim verification disabled');

  // Start webhook server
  const app = createWebhookServer(signalBuffer, logger, config.webhook.secret);
  app.listen(config.webhook.port, () => {
    console.log(`Webhook server listening on :${config.webhook.port}`);
  });

  const grokClient = process.env.XAI_API_KEY ? new GrokClient(process.env.XAI_API_KEY) : undefined;
  const enableSwarm = process.env.ENABLE_SWARM !== 'false';
  const swarmAgent = enableSwarm ? new SwarmAgent(llm, grokClient) : undefined;
  if (swarmAgent) console.log('[Swarm] SwarmAgent enabled (disable with ENABLE_SWARM=false)');
  if (swarmAgent && sessionId) {
    swarmAgent.sessionId = sessionId;
  }

  const flashCrashScanner = grokClient ? new FlashCrashScanner(grokClient) : undefined;
  if (flashCrashScanner) console.log('[FlashCrash] Scanner enabled (Grok)');

  const decisionJournal = new DecisionJournal('logs/decisions-journal.jsonl');
  const tradeStoryLogger = new TradeStoryLogger('logs/trade-stories.jsonl');

  let episodicAgent: EpisodicAgent | undefined;
  if (process.env.OPENAI_API_KEY_FALLBACK) {
    const embeddingClient = new EmbeddingClient(process.env.OPENAI_API_KEY_FALLBACK);
    const episodicStore = new EpisodicStore(join(process.env.DATA_DIR || './tmp', 'memory-graph.json'));
    episodicAgent = new EpisodicAgent(embeddingClient, episodicStore);
    console.log('[Memory] Episodic RAG enabled (Graph DB)');
  } else {
    console.warn('[Memory] Episodic RAG disabled — missing OPENAI_API_KEY_FALLBACK');
  }

  // Create trading loop
  const loop = new TradingLoop({
    pairs: config.trading.pairs,
    marketData,
    llm,
    swarmAgent,
    episodicAgent,
    orders,
    riskManager,
    signalBuffer,
    logger,
    newsClient,
    newsCache,
    newsAnalyst,
    newsConfig: {
      refreshIntervalH: config.trading.newsRefreshIntervalH,
      maxItems: config.trading.newsMaxItems,
    },
    churnCooldownMs: config.trading.churnCooldownMs,
    memory,
    tradingConfig: {
      ...promptConfig,
      stalePositionHours: config.trading.stalePositionHours,
      maxHoldHours: config.trading.maxHoldHours,
    },
    macroFetcher,
    macroAnalyst,
    macroRefreshIntervalMs: 10_800_000,
    fallbackLlm,
    memoryKeeper,
    memoryReview,
    rssFetcher,
    grokGrounder,
    sourceHealth,
    groundingConfig: {
      minImportance: parseInt(process.env.GROK_MIN_IMPORTANCE || '7', 10),
      maxPerCycle: parseInt(process.env.GROK_MAX_PER_CYCLE || '2', 10),
    },
    flashCrashScanner,
    decisionJournal,
    tradeStoryLogger,
    sessionId,
  });

  // Start Watchdog (1-min snapshots into DB)
  let watchdog: Watchdog | undefined;
  if (sessionId) {
    watchdog = new Watchdog({
      pairs: config.trading.pairs,
      marketData,
      sessionId,
      insertSnapshot: insertMarketSnapshot,
      getLatestSnapshot: getLatestMarketSnapshot,
      onAnomaly: (pair, type, detail) => {
        console.log(`[Watchdog] ANOMALY ${pair} ${type}: ${detail}`);
        logger.logError('WATCHDOG_ANOMALY', `${pair} ${type}: ${detail}`);
      },
    });
    watchdog.start(60_000);
    console.log('[Watchdog] Started — 1-min market snapshots');
  }

  // Run loop
  console.log('Starting trading loop...\n');

  const defaultIntervalMs = config.trading.loopIntervalMs;

  const runCycle = async () => {
    if (loop.isShutdown()) {
      console.log('\n*** BOT SHUTDOWN — max loss reached ***');
      process.exit(0);
    }

    // Auto-refresh OAuth token if needed (getOpenAIAccessToken returns cached or refreshes)
    try {
      const freshToken = await getOpenAIAccessToken();
      llm.updateAccessToken(freshToken);
    } catch (err: any) {
      console.warn('[Auth] Token refresh skipped:', err.message);
    }

    console.log(`\n--- Cycle at ${new Date().toISOString()} ---`);
    const nextCheckMinutes = await loop.runOnce();

    // Dynamic interval: LLM suggests next check, fallback to config default
    const minBrainMs = 10 * 60_000; // 10 min minimum for Brain without positions
    const hasPositions = loop.hasOpenPositions?.() ?? false;
    const effectiveMin = hasPositions ? defaultIntervalMs : minBrainMs;
    const nextMs = nextCheckMinutes
      ? Math.max(nextCheckMinutes * 60_000, effectiveMin)
      : effectiveMin;
    setTimeout(runCycle, nextMs);
  };

  // Run first cycle immediately
  await runCycle();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Bot] SIGTERM received — shutting down...');
    watchdog?.stop();
    if (sessionId) {
      const { endSession } = await import('./db/repository.js');
      await endSession(sessionId);
    }
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
