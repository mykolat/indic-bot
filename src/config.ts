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
  database: {
    url: string | undefined;
  };
  xaiApiKey: string | undefined;
  trading: {
    pairs: string[];
    minLeverage: number;
    maxLeverage: number;
    minPositionPct: number;
    loopIntervalMs: number;
    maxLossUsd: number;
    maxLossPct: number;
    maxPositionPct: number;
    maxExposurePct: number;
    maxStopLossPct: number;
    maxDrawdownPct: number;
    targetRiskPct: number;
    targetReturnPct: number;
    minTakeProfitPct: number;
    scalpingMinTakeProfitPct: number;
    scalpingMaxStopLossPct: number;
    newsRefreshIntervalH: number;
    newsMaxItems: number;
    churnCooldownMs: number;
    minConfidence: number;
    stalePositionHours: number;
    maxHoldHours: number;
    maxDailyLossPct: number;
    swarmVolumeThreshold: number;
    fearGreedLeverageCap: number;
    weekendLeverageMultiplier: number;
    useLimitEntry: boolean;
    limitEntryTimeoutMs: number;
  };
  positionManagement: {
    enabled: boolean;
    tp1CloseRatio: number;
    breakevenBufferPct: number;
    trailing: { enabled: boolean; callbackRatePct: number };
    regimeOverrides: Record<string, Partial<{ tp1CloseRatio: number; callbackRatePct: number }>>;
  };
  allocation: AllocationConfig;
}

export interface AllocationConfig {
  enabled: boolean;
  minFreeMarginPct: number;
  maxRebalancesPerHour: number;
  minHoldBeforeEvictMinutes: number;
  tpProgressLockThreshold: number;
  minDelta: number;
  churnPenalty: number;
  uncertaintyBand: number;
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
  const pm = y.positionManagement ?? {};
  const pmTrailing = pm.trailing ?? {};

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
    database: {
      url: process.env.DATABASE_URL,
    },
    xaiApiKey: process.env.XAI_API_KEY,
    trading: {
      pairs: t.pairs ?? ['BTCUSDT'],
      minLeverage: t.minLeverage ?? 1,
      maxLeverage: t.maxLeverage ?? 20,
      minPositionPct: t.minPositionPct ?? 0,
      loopIntervalMs: t.loopIntervalMs ?? 60000,
      maxLossUsd: t.maxLossUsd ?? 5,
      maxLossPct: t.maxLossPct ?? 10,
      maxPositionPct: t.maxPositionPct ?? 50,
      maxExposurePct: t.maxExposurePct ?? 150,
      maxStopLossPct: t.maxStopLossPct ?? 5,
      maxDrawdownPct: t.maxDrawdownPct ?? 15,
      targetRiskPct: t.targetRiskPct ?? 2,
      targetReturnPct: t.targetReturnPct ?? 100,
      minTakeProfitPct: t.minTakeProfitPct ?? 5,
      scalpingMinTakeProfitPct: t.scalpingMinTakeProfitPct ?? 1.0,
      scalpingMaxStopLossPct: t.scalpingMaxStopLossPct ?? 0.8,
      newsRefreshIntervalH: t.newsRefreshIntervalH ?? 0.33,
      newsMaxItems: t.newsMaxItems ?? 100,
      churnCooldownMs: t.churnCooldownMs ?? 900000,
      minConfidence: t.minConfidence ?? 55,
      stalePositionHours: t.stalePositionHours ?? 8,
      maxHoldHours: t.maxHoldHours ?? 24,
      maxDailyLossPct: t.maxDailyLossPct ?? 5,
      swarmVolumeThreshold: t.swarmVolumeThreshold ?? 0.8,
      fearGreedLeverageCap: t.fearGreedLeverageCap ?? 10,
      weekendLeverageMultiplier: t.weekendLeverageMultiplier ?? 0.5,
      useLimitEntry: t.useLimitEntry ?? false,
      limitEntryTimeoutMs: t.limitEntryTimeoutMs ?? 3000,
    },
    positionManagement: {
      enabled: pm.enabled ?? false,
      tp1CloseRatio: pm.tp1CloseRatio ?? 0.5,
      breakevenBufferPct: pm.breakevenBufferPct ?? 0.1,
      trailing: {
        enabled: pmTrailing.enabled ?? false,
        callbackRatePct: pmTrailing.callbackRatePct ?? 1.0,
      },
      regimeOverrides: pm.regimeOverrides ?? {},
    },
    allocation: {
      enabled: (y.allocation ?? {}).enabled ?? true,
      minFreeMarginPct: (y.allocation ?? {}).minFreeMarginPct ?? 15,
      maxRebalancesPerHour: (y.allocation ?? {}).maxRebalancesPerHour ?? 2,
      minHoldBeforeEvictMinutes: (y.allocation ?? {}).minHoldBeforeEvictMinutes ?? 30,
      tpProgressLockThreshold: (y.allocation ?? {}).tpProgressLockThreshold ?? 0.8,
      minDelta: (y.allocation ?? {}).minDelta ?? 5,
      churnPenalty: (y.allocation ?? {}).churnPenalty ?? 3,
      uncertaintyBand: (y.allocation ?? {}).uncertaintyBand ?? 2,
    },
  };
}
