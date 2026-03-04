import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import 'dotenv/config';

export interface Config {
  binance: {
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
  };
  openai: {
    apiKey: string;
    apiKeyFallback: string | undefined;
    model: string;
    fallbackModel: string;
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
    minConfidence: number;
    stalePositionHours: number;
    maxHoldHours: number;
    fearGreedLeverageCap: number;
  };
}

function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function loadYamlConfig(): Record<string, any> {
  const configPath = join(process.cwd(), 'config.yaml');
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf-8');
  return (yaml.load(raw) as Record<string, any>) || {};
}

export function loadConfig(): Config {
  const y = loadYamlConfig();
  const t = y.trading ?? {};
  const o = y.openai ?? {};
  const b = y.binance ?? {};
  const w = y.webhook ?? {};

  return {
    binance: {
      apiKey: requiredEnv('BINANCE_API_KEY'),
      apiSecret: requiredEnv('BINANCE_API_SECRET'),
      testnet: b.testnet ?? false,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || 'oauth',
      apiKeyFallback: process.env.OPENAI_API_KEY_FALLBACK,
      model: o.model ?? 'gpt-4o',
      fallbackModel: o.fallbackModel ?? 'gpt-4o-mini',
    },
    webhook: {
      port: w.port ?? 3000,
      secret: process.env.WEBHOOK_SECRET,
    },
    apifyToken: process.env.APIFY_API_TOKEN,
    trading: {
      pairs: t.pairs ?? ['BTCUSDT'],
      maxLeverage: t.maxLeverage ?? 20,
      loopIntervalMs: t.loopIntervalMs ?? 60000,
      maxLossUsd: t.maxLossUsd ?? 5,
      maxLossPct: t.maxLossPct ?? 10,
      maxPositionPct: t.maxPositionPct ?? 50,
      maxExposurePct: t.maxExposurePct ?? 150,
      maxStopLossPct: t.maxStopLossPct ?? 5,
      targetReturnPct: t.targetReturnPct ?? 100,
      minTakeProfitPct: t.minTakeProfitPct ?? 5,
      newsRefreshIntervalH: t.newsRefreshIntervalH ?? 0.33,
      newsMaxItems: t.newsMaxItems ?? 100,
      churnCooldownMs: t.churnCooldownMs ?? 900000,
      minConfidence: t.minConfidence ?? 55,
      stalePositionHours: t.stalePositionHours ?? 8,
      maxHoldHours: t.maxHoldHours ?? 24,
      fearGreedLeverageCap: t.fearGreedLeverageCap ?? 10,
    },
  };
}
