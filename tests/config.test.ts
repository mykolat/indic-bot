import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

// Mock fs before importing config
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Must import after mock setup
const { loadConfig } = await import('../src/config.js');

const FULL_YAML: Record<string, any> = {
  trading: {
    pairs: ['BTCUSDT', 'ETHUSDT'],
    maxLeverage: 15,
    loopIntervalMs: 30000,
    maxLossUsd: 20,
    maxLossPct: 8,
    maxPositionPct: 40,
    maxExposurePct: 120,
    maxStopLossPct: 3,
    targetReturnPct: 80,
    minTakeProfitPct: 4,
    newsRefreshIntervalH: 0.5,
    newsMaxItems: 50,
    churnCooldownMs: 600000,
    minConfidence: 60,
    stalePositionHours: 6,
    maxHoldHours: 18,
    fearGreedLeverageCap: 8,
  },
  openai: {
    model: 'gpt-5',
    fallbackModel: 'gpt-4o',
  },
  binance: {
    testnet: true,
  },
  webhook: {
    port: 4000,
  },
};

describe('loadConfig — config.yaml integration', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Set required secrets in process.env
    process.env.BINANCE_API_KEY = 'test-api-key';
    process.env.BINANCE_API_SECRET = 'test-api-secret';
    // Clear any env vars that would override yaml values
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY_FALLBACK;
    delete process.env.OPENAI_MODEL;
    delete process.env.FALLBACK_MODEL;
    delete process.env.WEBHOOK_PORT;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.BINANCE_TESTNET;
    delete process.env.TRADING_PAIRS;
    delete process.env.MAX_LEVERAGE;
    delete process.env.LOOP_INTERVAL_MS;
    delete process.env.MAX_LOSS_USD;
    delete process.env.MAX_LOSS_PCT;
    delete process.env.MAX_POSITION_PCT;
    delete process.env.MAX_EXPOSURE_PCT;
    delete process.env.MAX_STOP_LOSS_PCT;
    delete process.env.TARGET_RETURN_PCT;
    delete process.env.MIN_TAKE_PROFIT_PCT;
    delete process.env.NEWS_REFRESH_INTERVAL_H;
    delete process.env.NEWS_MAX_ITEMS;
    delete process.env.CHURN_COOLDOWN_MS;
    delete process.env.MIN_CONFIDENCE;
    delete process.env.STALE_POSITION_HOURS;
    delete process.env.MAX_HOLD_HOURS;
    delete process.env.FEAR_GREED_LEVERAGE_CAP;

    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reads trading params from config.yaml when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(yaml.dump(FULL_YAML));

    const cfg = loadConfig();

    expect(cfg.trading.pairs).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(cfg.trading.maxLeverage).toBe(15);
    expect(cfg.trading.loopIntervalMs).toBe(30000);
    expect(cfg.trading.maxLossUsd).toBe(20);
    expect(cfg.trading.minConfidence).toBe(60);
    expect(cfg.trading.churnCooldownMs).toBe(600000);
  });

  it('uses hardcoded defaults when config.yaml is missing', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const cfg = loadConfig();

    expect(cfg.trading.pairs).toEqual(['BTCUSDT']);
    expect(cfg.trading.maxLeverage).toBe(20);
    expect(cfg.trading.loopIntervalMs).toBe(60000);
    expect(cfg.trading.maxLossUsd).toBe(5);
    expect(cfg.trading.maxLossPct).toBe(10);
    expect(cfg.trading.maxPositionPct).toBe(50);
    expect(cfg.trading.maxExposurePct).toBe(150);
    expect(cfg.trading.maxStopLossPct).toBe(5);
    expect(cfg.trading.targetReturnPct).toBe(100);
    expect(cfg.trading.minTakeProfitPct).toBe(5);
    expect(cfg.trading.newsRefreshIntervalH).toBe(0.33);
    expect(cfg.trading.newsMaxItems).toBe(100);
    expect(cfg.trading.churnCooldownMs).toBe(900000);
    expect(cfg.trading.minConfidence).toBe(55);
    expect(cfg.trading.stalePositionHours).toBe(8);
    expect(cfg.trading.maxHoldHours).toBe(24);
    expect(cfg.trading.fearGreedLeverageCap).toBe(10);
    expect(cfg.openai.model).toBe('gpt-4o');
    expect(cfg.openai.fallbackModel).toBe('gpt-4o-mini');
    expect(cfg.webhook.port).toBe(3000);
    expect(cfg.binance.testnet).toBe(false);
  });

  it('secrets still come from process.env, not yaml', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(yaml.dump(FULL_YAML));

    const cfg = loadConfig();

    expect(cfg.binance.apiKey).toBe('test-api-key');
    expect(cfg.binance.apiSecret).toBe('test-api-secret');
  });

  it('throws when required secrets are missing from process.env', () => {
    delete process.env.BINANCE_API_KEY;
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => loadConfig()).toThrow('Missing required env var: BINANCE_API_KEY');
  });

  it('yaml values correctly populate all Config fields', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(yaml.dump(FULL_YAML));

    const cfg = loadConfig();

    // openai
    expect(cfg.openai.model).toBe('gpt-5');
    expect(cfg.openai.fallbackModel).toBe('gpt-4o');
    expect(cfg.openai.apiKey).toBe('oauth'); // no OPENAI_API_KEY env set

    // binance
    expect(cfg.binance.testnet).toBe(true);

    // webhook
    expect(cfg.webhook.port).toBe(4000);

    // trading — full check
    const t = cfg.trading;
    expect(t.maxLossPct).toBe(8);
    expect(t.maxPositionPct).toBe(40);
    expect(t.maxExposurePct).toBe(120);
    expect(t.maxStopLossPct).toBe(3);
    expect(t.targetReturnPct).toBe(80);
    expect(t.minTakeProfitPct).toBe(4);
    expect(t.newsRefreshIntervalH).toBe(0.5);
    expect(t.newsMaxItems).toBe(50);
    expect(t.stalePositionHours).toBe(6);
    expect(t.maxHoldHours).toBe(18);
    expect(t.fearGreedLeverageCap).toBe(8);
  });

  it('partial yaml merges with defaults', () => {
    const partialYaml = {
      trading: {
        pairs: ['SOLUSDT'],
        maxLeverage: 10,
        // all other trading fields omitted
      },
      // openai, binance, webhook sections omitted
    };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(yaml.dump(partialYaml));

    const cfg = loadConfig();

    // Provided values
    expect(cfg.trading.pairs).toEqual(['SOLUSDT']);
    expect(cfg.trading.maxLeverage).toBe(10);

    // Defaults for omitted trading fields
    expect(cfg.trading.loopIntervalMs).toBe(60000);
    expect(cfg.trading.maxLossUsd).toBe(5);
    expect(cfg.trading.minConfidence).toBe(55);

    // Defaults for omitted sections
    expect(cfg.openai.model).toBe('gpt-4o');
    expect(cfg.openai.fallbackModel).toBe('gpt-4o-mini');
    expect(cfg.binance.testnet).toBe(false);
    expect(cfg.webhook.port).toBe(3000);
  });

  it('env secrets override — OPENAI_API_KEY and WEBHOOK_SECRET', () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    process.env.WEBHOOK_SECRET = 'wh-secret';
    process.env.OPENAI_API_KEY_FALLBACK = 'sk-fallback';

    vi.mocked(existsSync).mockReturnValue(false);

    const cfg = loadConfig();

    expect(cfg.openai.apiKey).toBe('sk-test-key');
    expect(cfg.openai.apiKeyFallback).toBe('sk-fallback');
    expect(cfg.webhook.secret).toBe('wh-secret');
  });
});
