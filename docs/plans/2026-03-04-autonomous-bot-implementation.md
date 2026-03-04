# Autonomous Bot — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the bot autonomous for 1 week: position entry context for smart exits, aggressive configurable risk params, JSON session memory, performance logging, OAuth auto-refresh, pm2 process management.

**Architecture:** Each trading cycle the LLM now sees entry price + unrealized P&L for open positions, strategy rules baked into the system prompt, and a short session memory summary from prior cycles. A background token refresh checks expiry before each cycle. pm2 keeps the process alive.

**Tech Stack:** TypeScript/tsx, Node.js built-ins (fs, path), pm2 (global npm install), existing Binance/LLM clients.

---

## Task 1: Config — Add Aggressive Risk Params

**Files:**
- Modify: `src/config.ts`

**Step 1: Update `Config` interface and `loadConfig()`**

In `src/config.ts`, add to the `trading` block inside the interface:
```typescript
targetReturnPct: number;
minTakeProfitPct: number;
```

And in `loadConfig()` inside the `trading` object:
```typescript
targetReturnPct: parseFloat(process.env.TARGET_RETURN_PCT || '100'),
minTakeProfitPct: parseFloat(process.env.MIN_TAKE_PROFIT_PCT || '5'),
```

Also update existing defaults in `loadConfig()`:
```typescript
maxLeverage: parseInt(process.env.MAX_LEVERAGE || '20', 10),
maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || '50'),
maxExposurePct: parseFloat(process.env.MAX_EXPOSURE_PCT || '150'),
maxStopLossPct: parseFloat(process.env.MAX_STOP_LOSS_PCT || '5'),
loopIntervalMs: parseInt(process.env.LOOP_INTERVAL_MS || '60000', 10),
```

**Step 2: Update `.env`**

Add/update these lines in `.env`:
```env
TARGET_RETURN_PCT=100
MIN_TAKE_PROFIT_PCT=5
MAX_LEVERAGE=20
MAX_POSITION_PCT=50
MAX_EXPOSURE_PCT=150
MAX_STOP_LOSS_PCT=5
LOOP_INTERVAL_MS=60000
```

**Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/config.ts .env
git commit -m "feat: add aggressive risk params to config"
```

---

## Task 2: Position Entry Context (Binance → Position interface)

**Files:**
- Modify: `src/risk/manager.ts` (Position interface)
- Modify: `src/binance/market-data.ts` (mapping)
- Modify: `tests/binance/market-data.test.ts` (update fake data)

**Step 1: Extend `Position` interface in `src/risk/manager.ts`**

Add three fields to `Position`:
```typescript
export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
  entryPrice: number;        // NEW
  unrealizedPnlPct: number;  // NEW: signed % of margin (e.g. -2.4 or +8.1)
  heldHours: number;         // NEW: hours since position opened
}
```

**Step 2: Map new fields in `src/binance/market-data.ts`**

Inside `getPortfolioState()`, update the `.map()` for open positions:
```typescript
const openPositions: Position[] = positions
  .filter((p: any) => parseFloat(p.positionAmt) !== 0)
  .map((p: any) => {
    const notional = Math.abs(parseFloat(p.notional));
    const leverage = parseInt(p.leverage, 10);
    const margin = notional / leverage;
    const unrealizedProfit = parseFloat(p.unrealizedProfit || '0');
    const unrealizedPnlPct = margin > 0 ? (unrealizedProfit / margin) * 100 : 0;
    const updateTime = parseInt(p.updateTime || '0', 10);
    const heldHours = updateTime > 0
      ? (Date.now() - updateTime) / 3_600_000
      : 0;

    return {
      pair: p.symbol,
      sizeUsd: notional,
      leverage,
      side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
      entryPrice: parseFloat(p.entryPrice || '0'),
      unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
      heldHours: parseFloat(heldHours.toFixed(1)),
    };
  });
```

**Step 3: Update test fake data in `tests/binance/market-data.test.ts`**

Find any place that constructs a `Position` object and add the new fields with dummy values:
```typescript
entryPrice: 50000,
unrealizedPnlPct: 1.5,
heldHours: 2,
```

**Step 4: Run tests**

```bash
npx vitest run tests/
```
Expected: 31 passed.

**Step 5: Commit**

```bash
git add src/risk/manager.ts src/binance/market-data.ts tests/
git commit -m "feat: add entryPrice, unrealizedPnlPct, heldHours to Position"
```

---

## Task 3: Session Memory Module

**Files:**
- Create: `src/memory/session.ts`
- Create: `tests/memory/session.test.ts`

**Step 1: Write the failing test — `tests/memory/session.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, existsSync } from 'fs';

// Override HOME so tests don't touch real ~/.indic-bot
const TEST_HOME = join(tmpdir(), 'indic-bot-test-' + Date.now());
process.env.HOME = TEST_HOME;

import { SessionMemory } from '../../src/memory/session.js';

describe('SessionMemory', () => {
  let mem: SessionMemory;

  beforeEach(() => {
    mem = new SessionMemory();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  it('returns empty state when no file exists', () => {
    const state = mem.load();
    expect(state.session_notes).toBe('');
    expect(state.recent_trades).toHaveLength(0);
  });

  it('saves and loads state', () => {
    mem.save({ session_notes: 'test notes', recent_trades: [], last_updated: new Date().toISOString() });
    const state = mem.load();
    expect(state.session_notes).toBe('test notes');
  });

  it('addTrade keeps max 20 trades', () => {
    const state = mem.load();
    for (let i = 0; i < 25; i++) {
      mem.addTrade({ pair: 'BTCUSDT', action: 'LONG', pnlUsd: i, pnlPct: i, closedAt: new Date().toISOString() });
    }
    expect(mem.load().recent_trades).toHaveLength(20);
  });

  it('updateNotes sets session_notes', () => {
    mem.updateNotes('new insight: BTC trending up');
    expect(mem.load().session_notes).toBe('new insight: BTC trending up');
  });
});
```

**Step 2: Run to confirm failure**

```bash
npx vitest run tests/memory/
```
Expected: FAIL — "Cannot find module"

**Step 3: Implement `src/memory/session.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = join(process.env.HOME || '.', '.indic-bot');
const MEMORY_FILE = join(MEMORY_DIR, 'memory.json');

export interface TradeRecord {
  pair: string;
  action: string;
  pnlUsd: number;
  pnlPct: number;
  closedAt: string;
}

export interface MemoryState {
  session_notes: string;
  recent_trades: TradeRecord[];
  last_updated: string;
}

export class SessionMemory {
  load(): MemoryState {
    try {
      const raw = readFileSync(MEMORY_FILE, 'utf-8');
      return JSON.parse(raw) as MemoryState;
    } catch {
      return { session_notes: '', recent_trades: [], last_updated: '' };
    }
  }

  save(state: MemoryState): void {
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }

  addTrade(trade: TradeRecord): void {
    const state = this.load();
    state.recent_trades = [trade, ...state.recent_trades].slice(0, 20);
    state.last_updated = new Date().toISOString();
    this.save(state);
  }

  updateNotes(notes: string): void {
    const state = this.load();
    state.session_notes = notes;
    state.last_updated = new Date().toISOString();
    this.save(state);
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/
```
Expected: 35 passed.

**Step 5: Commit**

```bash
git add src/memory/session.ts tests/memory/session.test.ts
git commit -m "feat: add SessionMemory for cross-session JSON persistence"
```

---

## Task 4: Performance Logger

**Files:**
- Modify: `src/logger/index.ts`
- Modify: `tests/logger.test.ts`

**Step 1: Add `logPerformance` to `Logger` class**

In `src/logger/index.ts`, add after `logError`:
```typescript
logPerformance(entry: { balance: number; openPositions: number; sessionPnl: number; cycleCount: number }): void {
  this.append('performance.jsonl', entry);
}
```

**Step 2: Update test in `tests/logger.test.ts`**

Add one test:
```typescript
it('logs a performance snapshot to performance.jsonl', () => {
  logger.logPerformance({ balance: 5100, openPositions: 2, sessionPnl: 100, cycleCount: 10 });
  const content = readFileSync(join(tmpDir, 'performance.jsonl'), 'utf-8');
  expect(content).toContain('5100');
  expect(content).toContain('cycleCount');
});
```

**Step 3: Run tests**

```bash
npx vitest run tests/
```
Expected: 36 passed (one new test).

**Step 4: Commit**

```bash
git add src/logger/index.ts tests/logger.test.ts
git commit -m "feat: add performance snapshot logger"
```

---

## Task 5: Update System Prompt + Position Display

**Files:**
- Modify: `src/llm/prompts.ts`

This is the most impactful change — LLM now sees strategy rules and entry context.

**Step 1: Replace `SYSTEM_PROMPT` in `src/llm/prompts.ts`**

```typescript
export function buildSystemPrompt(config: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
}): string {
  return `You are an aggressive crypto futures trader. Target: +${config.targetReturnPct}% returns.

You receive: technical indicators, candles, funding rate, open interest, Fear & Greed, news, portfolio with open positions (entry price + P&L).

STRATEGY RULES (you may override with explicit reasoning):
- Trend-following: LONG if EMA20 > EMA50, SHORT if EMA20 < EMA50
- Momentum entry: RSI 40-65 for LONG entries, 35-60 for SHORT entries
- Funding arbitrage: extreme negative funding → crowded shorts → lean LONG
- Exit rule 1: position P&L < -${config.maxStopLossPct / 2}% and held > 4h with no progress → CLOSE
- Exit rule 2: RSI > 78 on active LONG → consider CLOSE; RSI < 22 on active SHORT → consider CLOSE
- Do NOT scalp. Minimum take-profit: ${config.minTakeProfitPct}%. Target swing moves.

CONSTRAINTS:
- Max leverage: ${config.maxLeverage}x
- Max position size: ${config.maxPositionPct}% of balance per trade
- Stop-loss MANDATORY for LONG/SHORT (1-${config.maxStopLossPct}%)
- This is a TESTNET account. Be aggressive. Take positions when you see a setup.

Respond ONLY with valid JSON:
{
  "decisions": [
    {
      "pair": "BTCUSDT",
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
      "size_pct": <0-${config.maxPositionPct}>,
      "leverage": <1-${config.maxLeverage}>,
      "stop_loss_pct": <1-${config.maxStopLossPct}>,
      "take_profit_pct": <${config.minTakeProfitPct}-50>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Always include a decision for every pair. HOLD = do nothing. CLOSE = close existing position.`;
}

// Keep backward compat for tests
export const SYSTEM_PROMPT = buildSystemPrompt({
  targetReturnPct: 100, minTakeProfitPct: 5,
  maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5,
});
```

**Step 2: Update `EnrichedPromptData` to include memory + config**

Add fields to the interface:
```typescript
export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
  portfolio: PortfolioState;
  signals: TradingViewSignal[];
  news: CryptoNews[];
  fearGreed: FearGreedData;
  sessionNotes?: string;      // NEW
  recentTrades?: TradeRecord[]; // NEW
}
```

Also add import at top: `import type { TradeRecord } from '../memory/session.js';`

**Step 3: Update position display in `buildEnrichedPrompt()`**

Replace the open positions block:
```typescript
if (data.portfolio.positions.length > 0) {
  prompt += 'Open positions:\n';
  for (const pos of data.portfolio.positions) {
    const pnlSign = pos.unrealizedPnlPct >= 0 ? '+' : '';
    prompt += `  ${pos.pair} ${pos.side} | entry $${pos.entryPrice.toFixed(2)} | held ${pos.heldHours.toFixed(1)}h | P&L: ${pnlSign}${pos.unrealizedPnlPct.toFixed(1)}% | ${pos.leverage}x leverage\n`;
  }
} else {
  prompt += 'No open positions.\n';
}
```

**Step 4: Add session memory section to prompt**

Before `\nProvide your trading decisions as JSON:`, add:
```typescript
if (data.sessionNotes) {
  prompt += '\n## Session Memory\n';
  prompt += data.sessionNotes + '\n';
}

if (data.recentTrades && data.recentTrades.length > 0) {
  prompt += '\n## Recent Closed Trades\n';
  for (const t of data.recentTrades.slice(0, 5)) {
    const sign = t.pnlUsd >= 0 ? '+' : '';
    prompt += `- ${t.pair} ${t.action}: ${sign}$${t.pnlUsd.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%) closed ${t.closedAt}\n`;
  }
}
```

**Step 5: Run tests**

```bash
npx vitest run tests/
```
Expected: all pass (SYSTEM_PROMPT still exported as const for backward compat).

**Step 6: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: aggressive system prompt with strategy rules + position entry context display"
```

---

## Task 6: Wire Memory + Config into Trading Loop

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/llm/client.ts`

**Step 1: Update `TradingLoopDeps` in `src/trading-loop.ts`**

Add fields:
```typescript
import { SessionMemory } from './memory/session.js';
import { buildSystemPrompt } from './llm/prompts.js';

interface TradingLoopDeps {
  // ... existing fields ...
  memory: SessionMemory;
  tradingConfig: {
    targetReturnPct: number;
    minTakeProfitPct: number;
    maxLeverage: number;
    maxPositionPct: number;
    maxStopLossPct: number;
  };
}
```

**Step 2: Update `runOnce()` to pass memory into LLM analyze call**

In the `llm.analyze({...})` call, add:
```typescript
const memState = this.deps.memory.load();

const decisions = await llm.analyze({
  snapshots,
  indicators,
  portfolio,
  signals,
  news,
  fearGreed,
  sessionNotes: memState.session_notes || undefined,
  recentTrades: memState.recent_trades.slice(0, 5),
});
```

**Step 3: Add performance logging at end of `runOnce()`**

After the decisions loop, before the `catch`:
```typescript
logger.logPerformance({
  balance: portfolio.balanceUsd,
  openPositions: portfolio.positions.length,
  sessionPnl: this.sessionPnl,
  cycleCount: this.cycleCount,
});
this.cycleCount++;
```

Add `private cycleCount = 0;` to the class.

**Step 4: Update `LLMClient.analyze()` to use `buildSystemPrompt`**

In `src/llm/client.ts`, import `buildSystemPrompt` and add a `systemPrompt` field:
```typescript
import { buildUserPrompt, buildSystemPrompt, type EnrichedPromptData } from './prompts.js';

export class LLMClient {
  private accountId: string;
  private systemPrompt: string;

  constructor(
    private accessToken: string,
    private model: string,
    promptConfig?: { targetReturnPct: number; minTakeProfitPct: number; maxLeverage: number; maxPositionPct: number; maxStopLossPct: number },
  ) {
    this.accountId = extractAccountId(accessToken);
    this.systemPrompt = promptConfig ? buildSystemPrompt(promptConfig) : SYSTEM_PROMPT;
  }
```

Then in `analyze()` use `this.systemPrompt` instead of `SYSTEM_PROMPT`.

**Step 5: Run tests**

```bash
npx vitest run tests/
```
Expected: all pass.

**Step 6: Commit**

```bash
git add src/trading-loop.ts src/llm/client.ts
git commit -m "feat: wire session memory and performance logging into trading loop"
```

---

## Task 7: Wire Everything in `index.ts` + OAuth Auto-Refresh

**Files:**
- Modify: `src/index.ts`

**Step 1: Import `SessionMemory` and `buildSystemPrompt`**

```typescript
import { SessionMemory } from './memory/session.js';
import { buildSystemPrompt } from './llm/prompts.js';
```

**Step 2: Create memory instance and load at startup**

After `const logger = new Logger('logs');`:
```typescript
const memory = new SessionMemory();
const memState = memory.load();
if (memState.session_notes) {
  console.log('[Memory] Loaded session notes from prior session');
}
```

**Step 3: Build LLMClient with config**

Replace the existing `new LLMClient(accessToken, config.openai.model)`:
```typescript
const promptConfig = {
  targetReturnPct: config.trading.targetReturnPct,
  minTakeProfitPct: config.trading.minTakeProfitPct,
  maxLeverage: config.trading.maxLeverage,
  maxPositionPct: config.trading.maxPositionPct,
  maxStopLossPct: config.trading.maxStopLossPct,
};
const llm = new LLMClient(accessToken, config.openai.model, promptConfig);
```

**Step 4: Add OAuth auto-refresh before each cycle**

In `runCycle()`, before `await loop.runOnce()`:
```typescript
const runCycle = async () => {
  if (loop.isShutdown()) {
    console.log('\n*** BOT SHUTDOWN — max loss reached ***');
    process.exit(0);
  }

  // Auto-refresh OAuth token if expiring within 30 minutes
  try {
    const { getOpenAIAccessToken } = await import('./llm/oauth.js');
    const freshToken = await getOpenAIAccessToken();
    llm.updateAccessToken(freshToken);
  } catch (err: any) {
    console.warn('[Auth] Token refresh skipped:', err.message);
  }

  console.log(`\n--- Cycle at ${new Date().toISOString()} ---`);
  await loop.runOnce();
};
```

**Note:** `getOpenAIAccessToken()` already returns cached token if valid and refreshes if needed — no extra logic required.

**Step 5: Pass memory to trading loop**

```typescript
const loop = new TradingLoop({
  // ... existing fields ...
  memory,
  tradingConfig: promptConfig,
});
```

**Step 6: Compile and run**

```bash
npx tsc --noEmit
npx vitest run tests/
npm run dev
```

Watch for: `[Memory] Loaded session notes`, `[News] CryptoPanic via Apify enabled`, LLM decisions showing `entry $xxx | held Xh | P&L: +/-X%` for open positions.

**Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire memory, config-driven prompt, and OAuth auto-refresh in index.ts"
```

---

## Task 8: pm2 Autonomous Operation

**Step 1: Install pm2 globally**

```bash
npm install -g pm2
```

**Step 2: Start bot with pm2**

```bash
pm2 start "npm run dev" --name indic-bot --restart-delay=5000 --max-restarts=100 --log logs/pm2.log
```

**Step 3: Save and enable startup**

```bash
pm2 save
pm2 startup
```
Follow the printed instruction (usually: `sudo env PATH=... pm2 startup systemd -u $USER --hp $HOME`).

**Step 4: Verify**

```bash
pm2 status
pm2 logs indic-bot --lines 20
```
Expected: `indic-bot` status `online`, logs showing cycle output.

**Step 5: Commit pm2 config**

```bash
pm2 save  # saves ~/.pm2/dump.pm2
git add .
git commit -m "chore: add pm2 autonomous operation setup"
```

---

## Final Verification

```bash
npx tsc --noEmit           # zero errors
npx vitest run tests/      # all pass
pm2 logs indic-bot --lines 50  # bot running, decisions visible
```

After 1 week: review `logs/performance.jsonl` for equity curve, `logs/decisions.jsonl` for LLM reasoning quality.
