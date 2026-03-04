import 'dotenv/config';
import { loadConfig } from './config.js';
import { createBinanceClient } from './binance/client.js';
import { MarketDataFetcher } from './binance/market-data.js';
import { OrderExecutor } from './binance/orders.js';
import { LLMClient } from './llm/client.js';
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
  };
  const llm = new LLMClient(accessToken, config.openai.model, promptConfig);

  const newsCache = new NewsCache();
  const newsAnalyst = new NewsAnalystAgent(llm);

  const riskManager = new RiskManager({
    maxLeverage: config.trading.maxLeverage,
    maxPositionPct: config.trading.maxPositionPct,
    maxExposurePct: config.trading.maxExposurePct,
    maxStopLossPct: config.trading.maxStopLossPct,
    maxLossUsd: config.trading.maxLossUsd,
    maxLossPct: config.trading.maxLossPct,
  });

  const signalBuffer = new SignalBuffer({ maxSize: 50, ttlMs: 30 * 60 * 1000 });

  // News client (optional — only if Apify token is provided)
  const newsClient = config.apifyToken
    ? new CryptoPanicClient(config.apifyToken)
    : undefined;
  if (newsClient) console.log('[News] CryptoPanic via Apify enabled');
  else console.log('[News] No APIFY_API_TOKEN — news disabled');

  // Start webhook server
  const app = createWebhookServer(signalBuffer, logger, config.webhook.secret);
  app.listen(config.webhook.port, () => {
    console.log(`Webhook server listening on :${config.webhook.port}`);
  });

  // Create trading loop
  const loop = new TradingLoop({
    pairs: config.trading.pairs,
    marketData,
    llm,
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
    tradingConfig: promptConfig,
  });

  // Run loop
  console.log('Starting trading loop...\n');

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
    await loop.runOnce();
  };

  // Run first cycle immediately
  await runCycle();

  // Then every N ms
  setInterval(runCycle, config.trading.loopIntervalMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
