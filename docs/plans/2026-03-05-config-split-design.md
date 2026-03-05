# Config Split Design: Secrets vs Trading Parameters

**Date:** 2026-03-05
**Goal:** Move all non-secret configuration from `.env` to `config.yaml`. `.env` keeps only API keys/secrets.

---

## Problem

`.env` mixes secrets (API keys) and trading parameters (leverage, pairs, limits). This means:
- AI cannot safely read or modify trading config
- Risk of accidentally exposing secrets when sharing config
- No git history for parameter changes
- `sed` on production `.env` is fragile

---

## Design

### `.env` (secrets only, gitignored)

```env
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
OPENAI_API_KEY=...
OPENAI_API_KEY_FALLBACK=...
APIFY_API_TOKEN=...
WEBHOOK_SECRET=...
```

### `config.yaml` (git-versioned, AI-readable/writable)

```yaml
trading:
  pairs: [BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT]
  maxLeverage: 25
  maxPositionPct: 60
  maxExposurePct: 150
  maxStopLossPct: 5
  maxLossUsd: 30
  maxLossPct: 10
  targetReturnPct: 100
  minTakeProfitPct: 5
  minConfidence: 55
  churnCooldownMs: 900000
  loopIntervalMs: 60000
  newsRefreshIntervalH: 0.33
  newsMaxItems: 100
  stalePositionHours: 8
  maxHoldHours: 24
  fearGreedLeverageCap: 10

openai:
  model: gpt-5.3-codex
  fallbackModel: gpt-4o-mini

binance:
  testnet: false

webhook:
  port: 3000
```

### `src/config.ts` changes

- Add `js-yaml` dependency
- `loadConfig()` reads `config.yaml` for all non-secret params
- `.env` used only for secrets via `requiredEnv()` / `process.env`
- Fallback: if `config.yaml` not found → use hardcoded defaults (backwards compat for dev)

---

## Files Changed

1. **`config.yaml`** — new file (root of project)
2. **`src/config.ts`** — yaml parsing instead of `process.env` for non-secrets
3. **`package.json`** — add `js-yaml` + `@types/js-yaml`
4. **Production `.env`** — remove config params, keep only secrets

## Production Deploy

After merge: rsync config.yaml to production, clean `.env` of config params, `pm2 restart`.
