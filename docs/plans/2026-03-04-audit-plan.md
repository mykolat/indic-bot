# AI Audit System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move trading config to AI-writable `config.yaml`, enhance audit script with session metrics + issues detection, add `npm run audit:debug` JSON mode, and create `/audit` skill so Claude can self-diagnose and heal the bot.

**Architecture:** `config.yaml` holds all trading parameters (AI can Edit it); `.env` holds secrets only. `scripts/audit.ts` gains two modes: human tables (existing) and `AUDIT_MODE=debug` → full JSON to stdout. Claude reads JSON via `npm run audit:debug`, diagnoses via `/audit` skill, then updates `memory.json`, `config.yaml`, and code.

**Tech Stack:** TypeScript ESM, `js-yaml` for YAML parsing, Vitest for tests, existing `logs/*.jsonl` + Binance API for metrics.

---

### Task 1: Install js-yaml + create config.yaml

**Files:**
- Modify: `package.json`
- Create: `config.yaml`
- Create: `config.example.yaml`

**Step 1: Install js-yaml**

```bash
npm install js-yaml
npm install --save-dev @types/js-yaml
```

Expected: `package.json` updated with `js-yaml` in dependencies.

**Step 2: Create `config.yaml`** with all current trading defaults:

```yaml
# Trading bot configuration
# Secrets (API keys) stay in .env — never put keys here

binance:
  testnet: true

trading:
  pairs:
    - BTCUSDT
    - ETHUSDT
    - SOLUSDT
  maxLeverage: 20
  maxPositionPct: 50
  maxExposurePct: 150
  maxStopLossPct: 5
  maxLossUsd: 5
  maxLossPct: 10
  churnCooldownMs: 900000     # 15 minutes
  loopIntervalMs: 60000       # 1 minute
  targetReturnPct: 100
  minTakeProfitPct: 5
  newsRefreshIntervalH: 12
  newsMaxItems: 100

webhook:
  port: 3000
```

**Step 3: Create `config.example.yaml`** — identical content, committed to git as reference.

**Step 4: Add `config.yaml` to `.gitignore`** (AI will modify it, keep out of git history):

Check `.gitignore` — add `config.yaml` if not already there.

Wait — actually `config.yaml` should be IN git (it has no secrets). Only `.env` stays gitignored. Do NOT add config.yaml to .gitignore.

**Step 5: Commit**

```bash
git add config.yaml config.example.yaml package.json package-lock.json
git commit -m "feat: add config.yaml for AI-writable trading parameters"
```

---

### Task 2: Update `src/config.ts` to read from config.yaml

**Files:**
- Modify: `src/config.ts`
- Create: `tests/config.test.ts`

**Step 1: Write failing tests**

Create `tests/config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// We test the yaml-loading helper in isolation
// by mocking fs and process.env

describe('loadConfig yaml integration', () => {
  it('uses yaml values when env vars are absent', async () => {
    vi.stubEnv('BINANCE_API_KEY', 'test-key');
    vi.stubEnv('BINANCE_API_SECRET', 'test-secret');
    vi.stubEnv('TRADING_PAIRS', '');
    vi.stubEnv('MAX_LEVERAGE', '');

    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((p: string) => p === 'config.yaml' ? true : actual.existsSync(p)),
        readFileSync: vi.fn((p: string, enc: any) =>
          p === 'config.yaml'
            ? 'trading:\n  maxLeverage: 7\n  pairs:\n    - BTCUSDT\n'
            : actual.readFileSync(p, enc)
        ),
      };
    });

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.trading.maxLeverage).toBe(7);
    expect(config.trading.pairs).toEqual(['BTCUSDT']);

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('env vars override yaml values', async () => {
    vi.stubEnv('BINANCE_API_KEY', 'test-key');
    vi.stubEnv('BINANCE_API_SECRET', 'test-secret');
    vi.stubEnv('MAX_LEVERAGE', '15');

    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((p: string) => p === 'config.yaml' ? true : actual.existsSync(p)),
        readFileSync: vi.fn((p: string, enc: any) =>
          p === 'config.yaml' ? 'trading:\n  maxLeverage: 7\n' : actual.readFileSync(p, enc)
        ),
      };
    });

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.trading.maxLeverage).toBe(15); // env wins

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL — `loadConfig` doesn't read yaml yet.

**Step 3: Update `src/config.ts`**

Replace entire file:

```typescript
import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import yaml from 'js-yaml';

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

interface YamlConfig {
  binance?: { testnet?: boolean };
  trading?: {
    pairs?: string[];
    maxLeverage?: number;
    loopIntervalMs?: number;
    maxLossUsd?: number;
    maxLossPct?: number;
    maxPositionPct?: number;
    maxExposurePct?: number;
    maxStopLossPct?: number;
    targetReturnPct?: number;
    minTakeProfitPct?: number;
    newsRefreshIntervalH?: number;
    newsMaxItems?: number;
    churnCooldownMs?: number;
  };
  webhook?: { port?: number };
}

function loadYamlConfig(): YamlConfig {
  const path = 'config.yaml';
  if (!existsSync(path)) return {};
  try {
    return (yaml.load(readFileSync(path, 'utf-8')) as YamlConfig) || {};
  } catch {
    return {};
  }
}

function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// Priority: env var > yaml > hardcoded default
function envOr(envKey: string, yamlVal: unknown, defaultVal: string): string {
  return process.env[envKey] || String(yamlVal ?? defaultVal);
}

export function loadConfig(): Config {
  const y = loadYamlConfig();
  const t = y.trading || {};

  return {
    binance: {
      apiKey: requiredEnv('BINANCE_API_KEY'),
      apiSecret: requiredEnv('BINANCE_API_SECRET'),
      testnet: process.env.BINANCE_TESTNET !== undefined
        ? process.env.BINANCE_TESTNET === 'true'
        : (y.binance?.testnet ?? false),
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || 'oauth',
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    },
    webhook: {
      port: parseInt(envOr('WEBHOOK_PORT', y.webhook?.port, '3000'), 10),
      secret: process.env.WEBHOOK_SECRET,
    },
    apifyToken: process.env.APIFY_API_TOKEN,
    trading: {
      pairs: process.env.TRADING_PAIRS
        ? process.env.TRADING_PAIRS.split(',')
        : (t.pairs ?? ['BTCUSDT']),
      maxLeverage: parseInt(envOr('MAX_LEVERAGE', t.maxLeverage, '20'), 10),
      loopIntervalMs: parseInt(envOr('LOOP_INTERVAL_MS', t.loopIntervalMs, '60000'), 10),
      maxLossUsd: parseFloat(envOr('MAX_LOSS_USD', t.maxLossUsd, '5')),
      maxLossPct: parseFloat(envOr('MAX_LOSS_PCT', t.maxLossPct, '10')),
      maxPositionPct: parseFloat(envOr('MAX_POSITION_PCT', t.maxPositionPct, '50')),
      maxExposurePct: parseFloat(envOr('MAX_EXPOSURE_PCT', t.maxExposurePct, '150')),
      maxStopLossPct: parseFloat(envOr('MAX_STOP_LOSS_PCT', t.maxStopLossPct, '5')),
      targetReturnPct: parseFloat(envOr('TARGET_RETURN_PCT', t.targetReturnPct, '100')),
      minTakeProfitPct: parseFloat(envOr('MIN_TAKE_PROFIT_PCT', t.minTakeProfitPct, '5')),
      newsRefreshIntervalH: parseInt(envOr('NEWS_REFRESH_INTERVAL_H', t.newsRefreshIntervalH, '12'), 10),
      newsMaxItems: parseInt(envOr('NEWS_MAX_ITEMS', t.newsMaxItems, '100'), 10),
      churnCooldownMs: parseInt(envOr('CHURN_COOLDOWN_MS', t.churnCooldownMs, '900000'), 10),
    },
  };
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/config.test.ts
```

Expected: PASS (2 tests)

**Step 5: Run all tests to verify no regression**

```bash
npx vitest run tests/
```

Expected: All 53 existing tests pass + 2 new = 55 total.

**Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: read trading config from config.yaml with env var override"
```

---

### Task 3: Add CHURN_BLOCK logging to trading-loop.ts

Currently when cooldown blocks a trade, it only prints to console — not logged to JSONL. Fix this so audit can count churn blocks.

**Files:**
- Modify: `src/trading-loop.ts:164-169`
- Modify: `tests/trading-loop.test.ts`

**Step 1: Update the failing test first**

In `tests/trading-loop.test.ts`, find the cooldown test and add expectation that logger.logDecision is called with `type: 'CHURN_BLOCK'`:

```typescript
it('logs CHURN_BLOCK decision when pair is within cooldown', async () => {
  // ... existing setup that triggers cooldown ...
  // After second cycle, verify logDecision called with CHURN_BLOCK
  expect(deps.logger.logDecision).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'CHURN_BLOCK', pair: 'BTCUSDT' })
  );
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run tests/trading-loop.test.ts
```

Expected: FAIL — no CHURN_BLOCK logged yet.

**Step 3: Update `src/trading-loop.ts` lines 164-169**

Replace the cooldown block from:
```typescript
const lastClose = this.lastClosedAt.get(decision.pair);
if (lastClose && Date.now() - lastClose < this.deps.churnCooldownMs) {
  const remainingMin = Math.round((this.deps.churnCooldownMs - (Date.now() - lastClose)) / 60000);
  console.log(`[Churn] Skipping ${decision.pair} ${decision.action} — cooldown ${remainingMin}m remaining`);
  continue;
}
```

To:
```typescript
const lastClose = this.lastClosedAt.get(decision.pair);
if (lastClose && Date.now() - lastClose < this.deps.churnCooldownMs) {
  const remainingMs = this.deps.churnCooldownMs - (Date.now() - lastClose);
  const remainingMin = Math.round(remainingMs / 60000);
  console.log(`[Churn] Skipping ${decision.pair} ${decision.action} — cooldown ${remainingMin}m remaining`);
  logger.logDecision({ type: 'CHURN_BLOCK', pair: decision.pair, action: decision.action, cooldownRemainingMs: remainingMs });
  continue;
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/trading-loop.test.ts
```

Expected: All 6 tests pass.

**Step 5: Run all tests**

```bash
npx vitest run tests/
```

Expected: All 55 tests pass.

**Step 6: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: log CHURN_BLOCK decisions to JSONL for audit tracking"
```

---

### Task 4: Audit helper functions + tests

Extract all computation logic from `scripts/audit.ts` into an exportable module so it can be tested.

**Files:**
- Create: `scripts/audit-helpers.ts`
- Create: `tests/audit-helpers.test.ts`

**Step 1: Write failing tests**

Create `tests/audit-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  detectCurrentSessionStart,
  computeSessionMetrics,
  detectIssues,
} from '../scripts/audit-helpers.js';

describe('detectCurrentSessionStart', () => {
  it('returns index 0 when no restart', () => {
    const perf = [
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: 'T1' },
      { cycleCount: 1, balance: 5001, sessionPnl: 0, timestamp: 'T2' },
      { cycleCount: 2, balance: 5002, sessionPnl: 0, timestamp: 'T3' },
    ];
    expect(detectCurrentSessionStart(perf)).toBe(0);
  });

  it('returns last reset index when bot restarted', () => {
    const perf = [
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: 'T1' },
      { cycleCount: 3, balance: 5000, sessionPnl: 0, timestamp: 'T2' },
      { cycleCount: 0, balance: 4000, sessionPnl: 0, timestamp: 'T3' }, // restart
      { cycleCount: 1, balance: 4001, sessionPnl: 0, timestamp: 'T4' },
    ];
    expect(detectCurrentSessionStart(perf)).toBe(2);
  });
});

describe('computeSessionMetrics', () => {
  it('computes cycle count and churn blocks', () => {
    const perf = [
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: '2026-03-04T10:00:00Z' },
      { cycleCount: 1, balance: 5100, sessionPnl: 0, timestamp: '2026-03-04T10:01:00Z' },
    ];
    const trades = [
      { type: 'LONG', pair: 'BTCUSDT', timestamp: '2026-03-04T10:00:30Z' },
    ];
    const decisions = [
      { type: 'CHURN_BLOCK', pair: 'SOLUSDT', timestamp: '2026-03-04T10:00:40Z' },
      { type: 'CHURN_BLOCK', pair: 'SOLUSDT', timestamp: '2026-03-04T10:01:40Z' },
    ];
    const metrics = computeSessionMetrics(perf, trades, decisions, '2026-03-04T10:00:00Z');
    expect(metrics.cycles).toBe(2);
    expect(metrics.churnBlocks).toBe(2);
    expect(metrics.totalTrades).toBe(1);
  });
});

describe('detectIssues', () => {
  it('detects sessionPnl always zero', () => {
    const perf = [
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: 'T1' },
      { cycleCount: 1, balance: 5100, sessionPnl: 0, timestamp: 'T2' },
      { cycleCount: 2, balance: 4900, sessionPnl: 0, timestamp: 'T3' },
    ];
    const issues = detectIssues({ perf, trades: [], decisions: [], openPositions: [] });
    expect(issues.some(i => i.includes('sessionPnl'))).toBe(true);
  });

  it('detects churn pattern (same pair closed 3+ times in 2h)', () => {
    const now = Date.now();
    const decisions = [
      { type: 'CHURN_BLOCK', pair: 'SOLUSDT', timestamp: new Date(now - 10000).toISOString() },
      { type: 'CHURN_BLOCK', pair: 'SOLUSDT', timestamp: new Date(now - 20000).toISOString() },
      { type: 'CHURN_BLOCK', pair: 'SOLUSDT', timestamp: new Date(now - 30000).toISOString() },
    ];
    const issues = detectIssues({ perf: [], trades: [], decisions, openPositions: [] });
    expect(issues.some(i => i.includes('SOLUSDT') && i.includes('churn'))).toBe(true);
  });

  it('detects multiple bot restarts in session', () => {
    const perf = [
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: 'T1' },
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: 'T2' },
      { cycleCount: 0, balance: 5000, sessionPnl: 0, timestamp: 'T3' },
    ];
    const issues = detectIssues({ perf, trades: [], decisions: [], openPositions: [] });
    expect(issues.some(i => i.includes('restart'))).toBe(true);
  });

  it('returns empty array when no issues', () => {
    const issues = detectIssues({ perf: [], trades: [], decisions: [], openPositions: [] });
    expect(issues).toEqual([]);
  });
});
```

**Step 2: Run to verify they fail**

```bash
npx vitest run tests/audit-helpers.test.ts
```

Expected: FAIL — `audit-helpers.ts` doesn't exist.

**Step 3: Create `scripts/audit-helpers.ts`**

```typescript
export interface PerfEntry {
  cycleCount: number;
  balance: number;
  sessionPnl: number;
  timestamp: string;
}

export interface SessionMetrics {
  startedAt: string;
  cycles: number;
  totalTrades: number;
  churnBlocks: number;
  riskRejections: number;
}

export interface IssueDetectionInput {
  perf: PerfEntry[];
  trades: any[];
  decisions: any[];
  openPositions: any[];
}

/** Returns the index in perf[] where the current (last) session starts. */
export function detectCurrentSessionStart(perf: PerfEntry[]): number {
  let lastReset = 0;
  for (let i = 1; i < perf.length; i++) {
    if (perf[i].cycleCount < perf[i - 1].cycleCount) {
      lastReset = i;
    }
  }
  return lastReset;
}

/** Compute session metrics from log arrays, filtered to entries >= sessionStart timestamp. */
export function computeSessionMetrics(
  perf: PerfEntry[],
  trades: any[],
  decisions: any[],
  sessionStart: string,
): SessionMetrics {
  const perfInSession = perf.filter(e => e.timestamp >= sessionStart);
  const tradesInSession = trades.filter(t => t.timestamp >= sessionStart);
  const decisionsInSession = decisions.filter(d => d.timestamp >= sessionStart);

  return {
    startedAt: sessionStart,
    cycles: perfInSession.length,
    totalTrades: tradesInSession.filter(t => ['LONG', 'SHORT', 'CLOSE'].includes(t.type)).length,
    churnBlocks: decisionsInSession.filter(d => d.type === 'CHURN_BLOCK').length,
    riskRejections: decisionsInSession.filter(d => d.type === 'RISK_REJECTED').length,
  };
}

/** Auto-detect issues from log data. Returns array of human-readable issue strings. */
export function detectIssues(input: IssueDetectionInput): string[] {
  const { perf, trades, decisions } = input;
  const issues: string[] = [];

  // Issue 1: sessionPnl is always 0 across multiple entries with balance changes
  if (perf.length >= 3) {
    const allZero = perf.every(e => e.sessionPnl === 0);
    const hasBalanceChange = perf[perf.length - 1].balance !== perf[0].balance;
    if (allZero && hasBalanceChange) {
      issues.push('sessionPnl is always 0 in performance.jsonl — realized PnL not tracked in trading-loop.ts');
    }
  }

  // Issue 2: Churn pattern — same pair blocked 3+ times recently (last 2h)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const recentChurns = decisions.filter(d => d.type === 'CHURN_BLOCK' && d.timestamp >= twoHoursAgo);
  const churnByPair: Record<string, number> = {};
  for (const c of recentChurns) {
    churnByPair[c.pair] = (churnByPair[c.pair] || 0) + 1;
  }
  for (const [pair, count] of Object.entries(churnByPair)) {
    if (count >= 3) {
      issues.push(`${pair}: churn pattern — cooldown blocked ${count} re-entries in last 2h`);
    }
  }

  // Issue 3: Multiple bot restarts (cycleCount resets 3+ times)
  let restartCount = 0;
  for (let i = 1; i < perf.length; i++) {
    if (perf[i].cycleCount < perf[i - 1].cycleCount) restartCount++;
  }
  if (restartCount >= 3) {
    issues.push(`Bot restarted ${restartCount} times in log history — check for crashes`);
  }

  return issues;
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/audit-helpers.test.ts
```

Expected: All 4 tests pass.

**Step 5: Run all tests**

```bash
npx vitest run tests/
```

Expected: All 55 tests pass + 4 new = 59 total.

**Step 6: Commit**

```bash
git add scripts/audit-helpers.ts tests/audit-helpers.test.ts
git commit -m "feat: audit helper functions for session detection and issues"
```

---

### Task 5: Enhanced audit.ts + debug JSON mode

**Files:**
- Modify: `scripts/audit.ts` (full rewrite)
- Modify: `package.json`

**Step 1: Rewrite `scripts/audit.ts`**

Note: This file is a CLI script, not unit tested directly. It uses the helpers from Task 4.

Key points:
- Import helpers from `./audit-helpers.js`
- `AUDIT_MODE=debug` → output JSON; otherwise → human tables
- Compute session metrics, realized PnL, issues
- `npm run audit` shows same sections as before + new SESSION METRICS + ISSUES sections

```typescript
/**
 * audit.ts — full snapshot of bot state + Binance account
 * Usage:
 *   npm run audit          → human-readable tables
 *   npm run audit:debug    → JSON to stdout (for AI analysis)
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { USDMClient } from 'binance';
import { loadConfig } from '../src/config.js';
import {
  detectCurrentSessionStart,
  computeSessionMetrics,
  detectIssues,
  type PerfEntry,
} from './audit-helpers.js';

const config = loadConfig();
const debugMode = process.env.AUDIT_MODE === 'debug';

// Use demo-fapi for testnet (same as main bot)
const client = new USDMClient({
  api_key: config.binance.apiKey,
  api_secret: config.binance.apiSecret,
  ...(config.binance.testnet ? { baseUrl: 'https://demo-fapi.binance.com' } : {}),
});

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function row(label: string, value: string | number) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

// ── Fetch all data ────────────────────────────────────────────
const account = await client.getAccountInformation();
const positions = await client.getPositions();
const open = positions.filter((p: any) => parseFloat(p.positionAmt) !== 0);

const pairs = config.trading.pairs;
const since = Date.now() - 24 * 60 * 60 * 1000;
const realizedByPair: Record<string, number> = {};
const allBinanceTrades: any[] = [];

for (const symbol of pairs) {
  try {
    const trades = await client.getAccountTrades({ symbol, startTime: since, limit: 100 });
    let pairTotal = 0;
    for (const t of trades as any[]) {
      const pnl = parseFloat(t.realizedPnl || '0');
      pairTotal += pnl;
      allBinanceTrades.push({ symbol, side: t.side, qty: t.qty, price: t.price, realizedPnl: pnl, time: t.time });
    }
    realizedByPair[symbol] = pairTotal;
  } catch { /* ignore */ }
}

const perf = readJsonl('logs/performance.jsonl') as PerfEntry[];
const trades = readJsonl('logs/trades.jsonl');
const errors = readJsonl('logs/errors.jsonl');
const decisions = readJsonl('logs/decisions.jsonl');

const sessionStartIdx = detectCurrentSessionStart(perf);
const sessionStartTs = perf[sessionStartIdx]?.timestamp ?? new Date().toISOString();
const sessionMetrics = computeSessionMetrics(perf, trades, decisions, sessionStartTs);
const issues = detectIssues({ perf, trades, decisions, openPositions: open });

// ── DEBUG JSON MODE ───────────────────────────────────────────
if (debugMode) {
  const payload = {
    generatedAt: new Date().toISOString(),
    account: {
      walletBalance: parseFloat(account.totalWalletBalance),
      marginBalance: parseFloat(account.totalMarginBalance),
      availableBalance: parseFloat(account.availableBalance),
      unrealizedPnl: parseFloat(account.totalUnrealizedProfit),
      initialMargin: parseFloat(account.totalInitialMargin),
    },
    openPositions: open.map((p: any) => {
      const notional = Math.abs(parseFloat(p.notional));
      const lev = parseInt(p.leverage);
      const margin = notional / lev;
      const pnl = parseFloat(p.unRealizedProfit);
      return {
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        leverage: lev,
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        margin: parseFloat(margin.toFixed(2)),
        notional: parseFloat(notional.toFixed(2)),
        unrealizedPnl: parseFloat(pnl.toFixed(2)),
        unrealizedPnlPct: parseFloat((pnl / margin * 100).toFixed(1)),
        liquidationPrice: parseFloat(p.liquidationPrice),
      };
    }),
    session: sessionMetrics,
    realizedPnl24h: {
      byPair: realizedByPair,
      total: parseFloat(Object.values(realizedByPair).reduce((a, b) => a + b, 0).toFixed(2)),
    },
    recentTrades: trades.slice(-20),
    recentDecisions: decisions.filter((d: any) => ['LONG','SHORT','CLOSE','CHURN_BLOCK','RISK_REJECTED'].includes(d.type)).slice(-30),
    recentErrors: errors.slice(-10),
    issues,
    config: {
      source: existsSync('config.yaml') ? 'config.yaml' : '.env',
      pairs: config.trading.pairs,
      maxLeverage: config.trading.maxLeverage,
      maxLossPct: config.trading.maxLossPct,
      churnCooldownMs: config.trading.churnCooldownMs,
      minTakeProfitPct: config.trading.minTakeProfitPct,
      maxStopLossPct: config.trading.maxStopLossPct,
    },
    newsCache: (() => {
      const cachePath = `${process.env.HOME}/.indic-bot/news-cache.json`;
      if (!existsSync(cachePath)) return null;
      try {
        const c = JSON.parse(readFileSync(cachePath, 'utf-8'));
        return {
          fetchedAt: c.fetchedAt,
          itemCount: c.items?.length ?? 0,
          sentiment: c.analysis?.overall_sentiment ?? null,
          signalCount: c.analysis?.top_signals?.length ?? 0,
        };
      } catch { return null; }
    })(),
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

// ── HUMAN MODE ────────────────────────────────────────────────
section('ACCOUNT (USDT)');
row('Wallet Balance',    `$${parseFloat(account.totalWalletBalance).toFixed(2)}`);
row('Margin Balance',    `$${parseFloat(account.totalMarginBalance).toFixed(2)}`);
row('Available Balance', `$${parseFloat(account.availableBalance).toFixed(2)}`);
row('Unrealized PnL',    `$${parseFloat(account.totalUnrealizedProfit).toFixed(2)}`);
row('Initial Margin',    `$${parseFloat(account.totalInitialMargin).toFixed(2)}`);

section('OPEN POSITIONS');
if (open.length === 0) {
  console.log('  No open positions.');
} else {
  for (const p of open as any[]) {
    const side = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const notional = Math.abs(parseFloat(p.notional));
    const lev = parseInt(p.leverage);
    const margin = notional / lev;
    const pnl = parseFloat(p.unRealizedProfit);
    console.log(`\n  ${p.symbol} ${side} ${lev}x`);
    row('  Entry Price',    `$${parseFloat(p.entryPrice).toFixed(2)}`);
    row('  Mark Price',     `$${parseFloat(p.markPrice).toFixed(2)}`);
    row('  Margin used',    `$${margin.toFixed(2)}`);
    row('  Unrealized PnL', `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(pnl/margin*100).toFixed(1)}%)`);
    row('  Liquidation',    `$${parseFloat(p.liquidationPrice).toFixed(2)}`);
  }
}

section('REALIZED PnL — LAST 24h');
let grandTotal = 0;
for (const symbol of pairs) {
  const pnl = realizedByPair[symbol];
  if (pnl === undefined) continue;
  grandTotal += pnl;
  row(symbol, `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
}
row('TOTAL', `${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(2)}`);

section('SESSION METRICS');
row('Started at',      sessionMetrics.startedAt.slice(0, 19) + 'Z');
row('Cycles',          sessionMetrics.cycles);
row('Trades executed', sessionMetrics.totalTrades);
row('Churn blocks',    sessionMetrics.churnBlocks);
row('Risk rejections', sessionMetrics.riskRejections);

if (issues.length > 0) {
  section('ISSUES DETECTED');
  for (const issue of issues) {
    console.log(`  ⚠  ${issue}`);
  }
}

section('BOT CONFIG');
row('Config source',  existsSync('config.yaml') ? 'config.yaml' : '.env only');
row('Pairs',          config.trading.pairs.join(', '));
row('Max leverage',   `${config.trading.maxLeverage}x`);
row('Max loss',       config.trading.maxLossPct > 0 ? `${config.trading.maxLossPct}% of balance` : `$${config.trading.maxLossUsd}`);
row('Churn cooldown', `${config.trading.churnCooldownMs / 60000}min`);
row('Min TP',         `${config.trading.minTakeProfitPct}%`);
row('Testnet',        String(config.binance.testnet));

console.log('\n');
```

**Step 2: Update `package.json` scripts**

Replace `"audit:bot"` and add two new scripts:

```json
"audit": "tsx scripts/audit.ts",
"audit:debug": "AUDIT_MODE=debug tsx scripts/audit.ts"
```

**Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

**Step 4: Test human mode**

```bash
npm run audit
```

Expected: Tables display with SESSION METRICS section and ISSUES DETECTED if any.

**Step 5: Test debug mode**

```bash
npm run audit:debug | head -20
```

Expected: Valid JSON starting with `{` and `"generatedAt"`.

**Step 6: Run all tests**

```bash
npx vitest run tests/
```

Expected: All 59 tests pass.

**Step 7: Commit**

```bash
git add scripts/audit.ts package.json
git commit -m "feat: audit debug JSON mode + session metrics + issues detection"
```

---

### Task 6: Create /audit skill

**Files:**
- Create: `~/.claude/skills/audit.md`

**Step 1: Create the skill file**

Create `~/.claude/skills/audit.md`:

```markdown
# /audit — AI Bot Self-Audit and Healing

When invoked, run a full diagnostic of the trading bot and apply fixes.

## Protocol

### 1. Gather data

Run: `npm run audit:debug`
Capture full JSON output.

Also read:
- `config.yaml` — current trading parameters
- `~/.indic-bot/memory.json` — current session notes

### 2. Diagnose

Check in order:

**Issues array** (pre-computed):
- If `sessionPnl always 0` → note as known bug, add to memory
- If churn pattern → increase `churnCooldownMs` in config.yaml (multiply by 1.5)
- If multiple restarts → investigate recent errors array

**Performance:**
- `session.totalTrades` > 0 and `realizedPnl24h.total < 0` → note loss in memory
- `realizedPnl24h.total / session.totalTrades` → avg PnL/trade (if < -$5 with >3 trades, flag)

**Open positions:**
- Any position with `unrealizedPnlPct < -15` → warn user immediately
- Any position near liquidation price → warn user

**Config sanity:**
- `churnCooldownMs < 300000` (5min) → too low, set to 900000
- `maxLossPct > 20` → too high for real money, warn

### 3. Act

**Update `~/.indic-bot/memory.json`:**
Add diagnosis to `session_notes`. Format:
```
[AUDIT 2026-03-04] winrate 33%, avg -$12/trade. SOL churn 3x. Increased cooldown to 30min.
```

**Update `config.yaml`:**
Edit the relevant parameters. Then restart the bot:
```bash
pm2 restart indic-bot
```

**Fix code if needed:**
If issues point to a bug (e.g., sessionPnl not tracked), create a fix using the standard development workflow.

### 4. Report to user

Summarize in 3-5 bullet points:
- What you found
- What you changed
- What requires user action (if any)
```

**Step 2: Verify skill file is readable**

```bash
cat ~/.claude/skills/audit.md | head -5
```

Expected: First line is `# /audit — AI Bot Self-Audit and Healing`

**Step 3: Commit the skill into project docs as reference**

```bash
cp ~/.claude/skills/audit.md docs/skills/audit.md
git add docs/skills/audit.md
git commit -m "feat: /audit skill for AI self-diagnosis and healing"
```

---

### Final: Run full verification

**Step 1: All tests pass**

```bash
npx vitest run tests/
```

Expected: ~59 tests pass.

**Step 2: TypeScript clean**

```bash
npx tsc --noEmit
```

Expected: No errors.

**Step 3: Restart bot with new config.yaml**

```bash
pm2 restart indic-bot
sleep 5
pm2 logs indic-bot --lines 15 --nostream
```

Expected: Bot starts, loads config from yaml (no errors).

**Step 4: Verify both audit modes work**

```bash
npm run audit         # human tables
npm run audit:debug | python3 -m json.tool | head -30   # valid JSON
```

**Step 5: Final commit**

```bash
git add -A
git status  # verify only expected files
git commit -m "feat: complete AI audit system — config.yaml + debug JSON + /audit skill"
```
