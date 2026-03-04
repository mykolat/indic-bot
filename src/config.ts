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
  trading: {
    pairs: string[];
    maxLeverage: number;
    loopIntervalMs: number;
    maxLossUsd: number;
    maxPositionPct: number;
    maxExposurePct: number;
    maxStopLossPct: number;
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
    trading: {
      pairs: (process.env.TRADING_PAIRS || 'BTCUSDT').split(','),
      maxLeverage: parseInt(process.env.MAX_LEVERAGE || '10', 10),
      loopIntervalMs: parseInt(process.env.LOOP_INTERVAL_MS || '300000', 10),
      maxLossUsd: parseFloat(process.env.MAX_LOSS_USD || '5'),
      maxPositionPct: 33,
      maxExposurePct: 50,
      maxStopLossPct: 3,
    },
  };
}
