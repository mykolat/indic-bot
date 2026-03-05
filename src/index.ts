import 'dotenv/config';
if (process.env.GLOBAL_AGENT_HTTPS_PROXY) {
  const { bootstrap } = await import('global-agent');
  bootstrap();
}
import { loadConfig } from './config.js';
import { createBinanceClient } from './binance/client.js';
import { MarketDataFetcher } from './binance/market-data.js';
import { OrderExecutor } from './binance/orders.js';
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

async function main() {
  const config = loadConfig();
  const logger = new Logger('logs');

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
  const orders = new OrderExecutor(binanceClient);

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

  const fallbackLlm = config.openai.apiKeyFallback
    ? new FallbackLLMClient(config.openai.apiKeyFallback, config.openai.fallbackModel)
    : undefined;
  if (fallbackLlm) {
    console.log(`[Fallback] Layer 2 enabled — ${config.openai.fallbackModel} (OPENAI_API_KEY_FALLBACK)`);
  } else {
    console.log('[Fallback] No OPENAI_API_KEY_FALLBACK — Layer 3 (rule-based) on Codex failure');
  }

  const memoryKeeper = new MemoryKeeper(join(process.env.HOME || '.', '.indic-bot'));
  const memoryReview = new MemoryReviewAgent({ llm, memoryKeeper });
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

  const swarmAgent = new SwarmAgent(llm);

  // Create trading loop
  const loop = new TradingLoop({
    pairs: config.trading.pairs,
    marketData,
    llm,
    swarmAgent,
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
  });

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
    const nextMs = nextCheckMinutes
      ? Math.max(nextCheckMinutes * 60_000, defaultIntervalMs)
      : defaultIntervalMs;
    setTimeout(runCycle, nextMs);
  };

  // Run first cycle immediately
  await runCycle();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
