# Config Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all non-secret config from `.env` to `config.yaml`. `.env` keeps only API keys.

**Architecture:** `config.yaml` (git-versioned) holds all trading/model/webhook params. `loadConfig()` reads yaml first, falls back to hardcoded defaults if file missing. Secrets still from `process.env` via dotenv.

**Tech Stack:** js-yaml for parsing, vitest for tests

---

### Task 1: Add js-yaml dependency

**Files:**
- Modify: `package.json`

**Step 1: Install js-yaml**

Run: `npm install js-yaml && npm install -D @types/js-yaml`

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add js-yaml dependency for config split"
```

---

### Task 2: Create config.yaml

**Files:**
- Create: `config.yaml`

**Step 1: Create config.yaml with production values**

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

**Step 2: Commit**

```bash
git add config.yaml
git commit -m "feat: add config.yaml with production trading parameters"
```

---

### Task 3: Write tests for yaml config loading

**Files:**
- Create: `tests/config.test.ts`

**Step 1: Write tests**

Test cases:
1. `loadConfig()` reads from config.yaml when file exists
2. `loadConfig()` uses defaults when config.yaml is missing
3. Secrets still come from `process.env`
4. yaml values override hardcoded defaults
5. Partial yaml (only some fields) merges with defaults

Use `vi.mock('fs')` to mock file reads. Mock `process.env` for secrets.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (loadConfig still reads from process.env)

**Step 3: Commit failing tests**

```bash
git add tests/config.test.ts
git commit -m "test: add config.yaml loading tests (red phase)"
```

---

### Task 4: Refactor loadConfig() to read config.yaml

**Files:**
- Modify: `src/config.ts`

**Step 1: Implement yaml loading**

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import 'dotenv/config';

// ... Config interface stays the same ...

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
```

Key changes:
- Remove all `process.env` reads for non-secret params
- Read `config.yaml` via `js-yaml`
- Keep `requiredEnv()` for secrets only
- Fallback defaults if yaml field missing

**Step 2: Run tests**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All pass

**Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: loadConfig reads config.yaml for non-secret params"
```

---

### Task 5: Create deploy script

**Files:**
- Create: `scripts/deploy.sh`

**Step 1: Write deploy script**

```bash
#!/bin/bash
set -euo pipefail

REMOTE="mykolat@34.179.171.213"
SSH_KEY="~/.ssh/google_compute_engine"
REMOTE_DIR="~/indic-bot"

echo "=== Deploying indic-bot ==="

# 1. Sync code (exclude secrets, node_modules, logs)
echo "[1/3] Syncing files..."
rsync -az --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude logs \
  . "$REMOTE:$REMOTE_DIR/"

# 2. Install deps if package.json changed
echo "[2/3] Installing dependencies..."
ssh -i "$SSH_KEY" "$REMOTE" "cd $REMOTE_DIR && npm install --production"

# 3. Restart bot
echo "[3/3] Restarting bot..."
ssh -i "$SSH_KEY" "$REMOTE" "cd $REMOTE_DIR && pm2 restart indic-bot"

echo "=== Deploy complete ==="
echo "Check logs: ssh -i $SSH_KEY $REMOTE 'pm2 logs indic-bot --lines 20'"
```

**Step 2: Make executable**

Run: `chmod +x scripts/deploy.sh`

**Step 3: Add npm script**

Add to package.json scripts: `"deploy": "bash scripts/deploy.sh"`

**Step 4: Commit**

```bash
git add scripts/deploy.sh package.json
git commit -m "feat: add deploy script (rsync + pm2 restart)"
```

---

### Task 6: Clean production .env

**Step 1: Remove config params from production .env**

SSH to production and remove non-secret lines:

```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 \
  "cd ~/indic-bot && grep -E '^(BINANCE_API|OPENAI_API|APIFY_API|WEBHOOK_SECRET|GLOBAL_AGENT)' .env > .env.secrets && mv .env.secrets .env"
```

**Step 2: Deploy and verify**

Run: `npm run deploy`

Then verify:
```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 \
  "cd ~/indic-bot && pm2 logs indic-bot --lines 20"
```

Expected: Bot starts, prints `Pairs: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT`

**Step 3: Commit all and tag**

```bash
git add -A
git commit -m "feat: config split complete — secrets in .env, params in config.yaml"
```
