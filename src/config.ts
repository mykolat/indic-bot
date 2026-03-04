import 'dotenv/config';

export interface Config {
  binance: {
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
  };
  openai: {
    apiKey: string;
    model: string;
  };
  webhook: {
    port: number;
    secret: string | undefined;
  };
  apifyToken: string | undefined;
  trading: {
    pairs: string[];
    maxLeverage: number;
    loopIntervalMs: number;
    maxLossUsd: number;
    maxLossPct: number;
    maxPositionPct: number;
    maxExposurePct: number;
    maxStopLossPct: number;
    targetReturnPct: number;
    minTakeProfitPct: number;
    newsRefreshIntervalH: number;
    newsMaxItems: number;
    churnCooldownMs: number;
  };
}

function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export function loadConfig(): Config {
  return {
    binance: {
      apiKey: requiredEnv('BINANCE_API_KEY'),
      apiSecret: requiredEnv('BINANCE_API_SECRET'),
      testnet: process.env.BINANCE_TESTNET === 'true',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || 'oauth',
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    },
    webhook: {
      port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
      secret: process.env.WEBHOOK_SECRET,
    },
    apifyToken: process.env.APIFY_API_TOKEN,
    trading: {
      pairs: (process.env.TRADING_PAIRS || 'BTCUSDT').split(','),
      maxLeverage: parseInt(process.env.MAX_LEVERAGE || '20', 10),
      loopIntervalMs: parseInt(process.env.LOOP_INTERVAL_MS || '60000', 10),
      maxLossUsd: parseFloat(process.env.MAX_LOSS_USD || '5'),
      maxLossPct: parseFloat(process.env.MAX_LOSS_PCT || '10'),
      maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || '50'),
      maxExposurePct: parseFloat(process.env.MAX_EXPOSURE_PCT || '150'),
      maxStopLossPct: parseFloat(process.env.MAX_STOP_LOSS_PCT || '5'),
      targetReturnPct: parseFloat(process.env.TARGET_RETURN_PCT || '100'),
      minTakeProfitPct: parseFloat(process.env.MIN_TAKE_PROFIT_PCT || '5'),
      newsRefreshIntervalH: parseInt(process.env.NEWS_REFRESH_INTERVAL_H || '12', 10),
      newsMaxItems: parseInt(process.env.NEWS_MAX_ITEMS || '100', 10),
      churnCooldownMs: parseInt(process.env.CHURN_COOLDOWN_MS || '900000', 10),
    },
  };
}
