# Asymmetric Risk Budget Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a self-adjusting risk budget system that protects realized profits via a ratchet floor and pauses new trades (not shutdown) when the daily risk budget is exhausted.

**Architecture:** New `src/risk/budget.ts` module persists state to `~/.indic-bot/risk-state.json`. `RiskManager.validate()` receives optional `RiskState` for two new guard checks (floor protection + budget exhaustion). Trading loop calls `riskBudget.update(balance)` each cycle before validation.

**Tech Stack:** TypeScript, Node.js `fs` (readFileSync/writeFileSync), Vitest

---

## Context

Design doc: `docs/plans/2026-03-04-asymmetric-risk-design.md`

Key files:
- `src/risk/manager.ts` — add two new checks to `validate()`
- `src/config.ts` — add 4 new env vars
- `src/trading-loop.ts` — call `riskBudget.update()` per cycle, pass `riskState`
- `src/index.ts` — create `RiskBudgetManager`, pass to loop
- `src/llm/prompts.ts` — show risk budget info in portfolio section

Run tests: `npx vitest run`
TypeScript check: `npx tsc --noEmit`

---

### Task 1: `src/risk/budget.ts` — RiskState interface + RiskBudgetManager

**Files:**
- Create: `src/risk/budget.ts`
- Create: `tests/risk/budget.test.ts`

**Step 1: Write failing tests**

Create `tests/risk/budget.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { RiskBudgetManager } from '../../src/risk/budget.js';

const TEST_HOME = '/tmp/indic-bot-test-budget';

beforeEach(() => {
  mkdirSync(join(TEST_HOME, '.indic-bot'), { recursive: true });
  vi.stubEnv('HOME', TEST_HOME);
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const defaultConfig = {
  riskBudgetPct: 10,
  riskBudgetMaxUsd: 100,
  milestoneMultiplier: 2,
  floorProtectionPct: 95,
};

describe('RiskBudgetManager', () => {
  it('returns defaults when no state file exists', () => {
    const mgr = new RiskBudgetManager();
    const state = mgr.update(100, defaultConfig);
    expect(state.highWaterMark).toBe(100);
    expect(state.riskBudget).toBe(10); // 10% of 100
    expect(state.currentFloor).toBe(0); // no floor until HWM is exceeded
    expect(state.milestoneReached).toBe(1);
  });

  it('caps risk budget at RISK_BUDGET_MAX_USD', () => {
    const mgr = new RiskBudgetManager();
    const state = mgr.update(5000, defaultConfig);
    expect(state.riskBudget).toBe(100); // 10% of 5000 = 500, capped at 100
  });

  it('updates highWaterMark and floor when balance increases', () => {
    const mgr = new RiskBudgetManager();
    mgr.update(100, defaultConfig);
    const state = mgr.update(150, defaultConfig);
    expect(state.highWaterMark).toBe(150);
    expect(state.currentFloor).toBeCloseTo(142.5); // 150 * 0.95
  });

  it('does NOT lower highWaterMark when balance drops', () => {
    const mgr = new RiskBudgetManager();
    mgr.update(150, defaultConfig);
    const state = mgr.update(120, defaultConfig);
    expect(state.highWaterMark).toBe(150); // stays at peak
    expect(state.currentFloor).toBeCloseTo(142.5);
  });

  it('detects milestone and recalculates budget', () => {
    const mgr = new RiskBudgetManager();
    mgr.update(100, defaultConfig); // milestone 1 at 100, next at 200
    const state = mgr.update(200, defaultConfig); // hits 2x
    expect(state.milestoneReached).toBe(2);
    expect(state.riskBudget).toBe(20); // 10% of 200
  });

  it('daily reset recalculates budget when balance dropped vs yesterday', () => {
    const mgr = new RiskBudgetManager();
    // Simulate yesterday state persisted with balance=100
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const state1 = mgr.update(100, defaultConfig);
    // Manually set lastResetDate to yesterday to trigger reset
    const raw = JSON.parse(require('fs').readFileSync(
      join(TEST_HOME, '.indic-bot', 'risk-state.json'), 'utf-8'
    ));
    raw.lastResetDate = yesterday.toISOString().slice(0, 10);
    raw.dailyStartBalance = 100;
    require('fs').writeFileSync(
      join(TEST_HOME, '.indic-bot', 'risk-state.json'),
      JSON.stringify(raw)
    );
    // Now update with a lower balance (simulating a loss day)
    const mgr2 = new RiskBudgetManager();
    const state2 = mgr2.update(90, defaultConfig);
    expect(state2.riskBudget).toBe(9); // 10% of 90 (reset from lower balance)
    expect(state2.dailyStartBalance).toBe(90);
  });

  it('daily reset does NOT change budget when balance grew vs yesterday', () => {
    const mgr = new RiskBudgetManager();
    mgr.update(100, defaultConfig);
    const raw = JSON.parse(require('fs').readFileSync(
      join(TEST_HOME, '.indic-bot', 'risk-state.json'), 'utf-8'
    ));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    raw.lastResetDate = yesterday.toISOString().slice(0, 10);
    raw.dailyStartBalance = 100;
    raw.riskBudget = 50; // pretend we hit a milestone
    require('fs').writeFileSync(
      join(TEST_HOME, '.indic-bot', 'risk-state.json'),
      JSON.stringify(raw)
    );
    const mgr2 = new RiskBudgetManager();
    const state2 = mgr2.update(120, defaultConfig); // balance grew
    expect(state2.riskBudget).toBe(50); // unchanged (not a loss day)
  });

  it('persists and loads state across instances', () => {
    const mgr1 = new RiskBudgetManager();
    mgr1.update(200, defaultConfig);

    const mgr2 = new RiskBudgetManager();
    const state = mgr2.update(200, defaultConfig); // same balance
    expect(state.highWaterMark).toBe(200);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/risk/budget.test.ts
```
Expected: FAIL with "Cannot find module '../../src/risk/budget.js'"

**Step 3: Implement `src/risk/budget.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface RiskState {
  highWaterMark: number;
  currentFloor: number;
  riskBudget: number;
  dailyStartBalance: number;
  lastResetDate: string;   // YYYY-MM-DD
  milestoneReached: number;
}

interface RiskBudgetConfig {
  riskBudgetPct: number;       // e.g. 10 (= 10%)
  riskBudgetMaxUsd: number;    // e.g. 100
  milestoneMultiplier: number; // e.g. 2 (2x, 3x, 4x...)
  floorProtectionPct: number;  // e.g. 95 (floor = HWM * 0.95)
}

export class RiskBudgetManager {
  private get stateDir() { return join(process.env.HOME || '.', '.indic-bot'); }
  private get stateFile() { return join(this.stateDir, 'risk-state.json'); }

  private load(): RiskState | null {
    try {
      const raw = readFileSync(this.stateFile, 'utf-8');
      return JSON.parse(raw) as RiskState;
    } catch {
      return null;
    }
  }

  private save(state: RiskState): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  getRiskState(): RiskState | null {
    return this.load();
  }

  update(balance: number, config: RiskBudgetConfig): RiskState {
    const today = new Date().toISOString().slice(0, 10);
    const calcBudget = (b: number) =>
      Math.min((b * config.riskBudgetPct) / 100, config.riskBudgetMaxUsd);

    const existing = this.load();

    // First-time init
    if (!existing) {
      const state: RiskState = {
        highWaterMark: balance,
        currentFloor: 0,
        riskBudget: calcBudget(balance),
        dailyStartBalance: balance,
        lastResetDate: today,
        milestoneReached: 1,
      };
      this.save(state);
      return state;
    }

    const state = { ...existing };

    // Daily reset (date changed)
    if (state.lastResetDate !== today) {
      if (balance < state.dailyStartBalance) {
        // Lost since yesterday — reset budget from current (lower) balance
        state.riskBudget = calcBudget(balance);
      }
      // Always update daily tracking
      state.dailyStartBalance = balance;
      state.lastResetDate = today;
    }

    // High-water mark tracking
    if (balance > state.highWaterMark) {
      state.highWaterMark = balance;
      state.currentFloor = state.highWaterMark * (config.floorProtectionPct / 100);
    }

    // Milestone detection: balance >= highWaterMark * multiplier^milestoneReached
    const nextMilestoneBalance = existing.highWaterMark * Math.pow(config.milestoneMultiplier, 1);
    // Simpler: milestone when balance >= initial_hwm * 2^n
    // Track by checking if balance >= hwm before update * multiplier
    if (balance >= existing.highWaterMark * config.milestoneMultiplier &&
        balance > existing.highWaterMark) {
      state.milestoneReached = existing.milestoneReached + 1;
      state.riskBudget = calcBudget(balance);
    }

    this.save(state);
    return state;
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/risk/budget.test.ts
```
Expected: most pass. Fix any failures — the daily reset test uses `require('fs')` inline — rewrite those tests to use proper `import { writeFileSync } from 'fs'` at the top and helper functions if needed. The logic should still be clear.

> **Note on the daily reset tests:** The test file above uses `require('fs')` inline which won't work in ESM. Fix by importing `writeFileSync` at top and using it in tests. Here's the corrected pattern:
```typescript
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
// ...
// In test body, to manipulate persisted state:
const statePath = join(TEST_HOME, '.indic-bot', 'risk-state.json');
const raw = JSON.parse(readFileSync(statePath, 'utf-8'));
raw.lastResetDate = yesterday.toISOString().slice(0, 10);
writeFileSync(statePath, JSON.stringify(raw));
```

**Step 5: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 6: Commit**

```bash
git add src/risk/budget.ts tests/risk/budget.test.ts
git commit -m "feat: add RiskBudgetManager with floor, milestone, daily reset"
```

---

### Task 2: Config — add 4 new env vars

**Files:**
- Modify: `src/config.ts` (lines 1-65)

**Step 1: No test needed** — config is a pure data loader, tested indirectly.

**Step 2: Edit `src/config.ts`**

Add to the `Config` interface `trading` block (after `minTakeProfitPct`):

```typescript
  trading: {
    // existing fields...
    riskBudgetPct: number;
    riskBudgetMaxUsd: number;
    milestoneMultiplier: number;
    floorProtectionPct: number;
  };
```

Add to `loadConfig()` `trading` block (after `minTakeProfitPct`):

```typescript
      riskBudgetPct: parseFloat(process.env.RISK_BUDGET_PCT || '10'),
      riskBudgetMaxUsd: parseFloat(process.env.RISK_BUDGET_MAX_USD || '100'),
      milestoneMultiplier: parseFloat(process.env.MILESTONE_MULTIPLIER || '2'),
      floorProtectionPct: parseFloat(process.env.FLOOR_PROTECTION_PCT || '95'),
```

**Step 3: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: errors in `src/index.ts` where config is used (not yet wired) — that's fine, will be fixed in Task 4.

**Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: add risk budget config vars (RISK_BUDGET_PCT, RISK_BUDGET_MAX_USD, etc)"
```

---

### Task 3: `src/risk/manager.ts` — add floor protection + budget exhaustion checks

**Files:**
- Modify: `src/risk/manager.ts`
- Modify: `tests/risk/manager.test.ts`

The design says these two checks go **before** all existing checks, and both return `shutdown: false` (bot keeps running, only new LONG/SHORT blocked).

**Step 1: Write failing tests**

Add to `tests/risk/manager.test.ts` (append after the last `it()` block, before closing `}`):

```typescript
import type { RiskState } from '../../src/risk/budget.js';

// ... inside the existing describe block:

  it('blocks new trade when balance is below floor', () => {
    const riskState: RiskState = {
      highWaterMark: 200,
      currentFloor: 190,
      riskBudget: 20,
      dailyStartBalance: 195,
      lastResetDate: '2026-03-04',
      milestoneReached: 2,
    };
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 185, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio, riskState);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('floor');
    expect(result.shutdown).toBeFalsy();
  });

  it('blocks new trade when risk budget is exhausted', () => {
    const riskState: RiskState = {
      highWaterMark: 100,
      currentFloor: 0,
      riskBudget: 10,
      dailyStartBalance: 100,
      lastResetDate: '2026-03-04',
      milestoneReached: 1,
    };
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    // sessionPnl = -10 = exactly exhausted (riskBudget = 10)
    const portfolio: PortfolioState = { balanceUsd: 90, positions: [], sessionPnl: -10 };

    const result = rm.validate(decision, portfolio, riskState);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('budget');
    expect(result.shutdown).toBeFalsy();
  });

  it('allows CLOSE even when below floor', () => {
    const riskState: RiskState = {
      highWaterMark: 200,
      currentFloor: 190,
      riskBudget: 20,
      dailyStartBalance: 195,
      lastResetDate: '2026-03-04',
      milestoneReached: 2,
    };
    const closeDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0,
      leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'close',
    };
    const portfolio: PortfolioState = { balanceUsd: 185, positions: [], sessionPnl: 0 };

    expect(rm.validate(closeDecision, portfolio, riskState).approved).toBe(true);
  });

  it('passes when no riskState provided (backward compat)', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };
    // No riskState passed — should behave as before
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/risk/manager.test.ts
```
Expected: FAIL — `validate()` doesn't accept 3rd argument yet.

**Step 3: Update `src/risk/manager.ts`**

Add the `RiskState` import at the top:

```typescript
import type { RiskState } from './budget.js';
```

Change `validate()` signature to accept optional third param:

```typescript
  validate(decision: TradeDecision, portfolio: PortfolioState, riskState?: RiskState): ValidationResult {
    if (decision.action === 'HOLD' || decision.action === 'CLOSE') {
      return { approved: true };
    }

    // Floor protection — block new trades if below floor
    if (riskState && riskState.currentFloor > 0 && portfolio.balanceUsd < riskState.currentFloor) {
      return {
        approved: false,
        reason: `balance $${portfolio.balanceUsd.toFixed(2)} below floor $${riskState.currentFloor.toFixed(2)} — protecting profits`,
        shutdown: false,
      };
    }

    // Risk budget exhausted — pause new trades until daily reset
    if (riskState && portfolio.sessionPnl <= -riskState.riskBudget) {
      return {
        approved: false,
        reason: `risk budget $${riskState.riskBudget.toFixed(2)} exhausted — waiting for daily reset`,
        shutdown: false,
      };
    }

    // ... rest of existing checks unchanged (maxLossUsd, leverage, etc.)
```

**Step 4: Run all tests**

```bash
npx vitest run
```
Expected: all tests pass (no regressions)

**Step 5: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors (or only errors from index.ts / trading-loop.ts not yet updated)

**Step 6: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts
git commit -m "feat: add floor protection and budget exhaustion checks to RiskManager"
```

---

### Task 4: Wire into `src/trading-loop.ts` and `src/index.ts`

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/index.ts`
- Modify: `tests/trading-loop.test.ts` (add mock for riskBudget if needed)

**Step 1: Check existing trading loop test**

Read `tests/trading-loop.test.ts` — verify it constructs `TradingLoop` with specific deps. If it does, you'll need to add `riskBudget` mock to those tests.

**Step 2: Update `src/trading-loop.ts`**

Add `RiskBudgetManager` import and dep:

```typescript
import type { RiskBudgetManager } from './risk/budget.js';
```

Add to `TradingLoopDeps` interface (after `memory`):

```typescript
  riskBudget: RiskBudgetManager;
  riskBudgetConfig: {
    riskBudgetPct: number;
    riskBudgetMaxUsd: number;
    milestoneMultiplier: number;
    floorProtectionPct: number;
  };
```

In `runOnce()`, after getting portfolio state (after line `portfolio.sessionPnl = this.sessionPnl;`), add:

```typescript
      // Update risk budget state each cycle
      const riskState = this.deps.riskBudget.update(portfolio.balanceUsd, this.deps.riskBudgetConfig);
```

Pass `riskState` to `riskManager.validate()` (line `const validation = riskManager.validate(decision, portfolio);`):

```typescript
        const validation = riskManager.validate(decision, portfolio, riskState);
```

**Step 3: Update `src/index.ts`**

Add imports:

```typescript
import { RiskBudgetManager } from './risk/budget.js';
```

After creating `riskManager`, create `riskBudget`:

```typescript
  const riskBudget = new RiskBudgetManager();
```

Add `riskBudget` and `riskBudgetConfig` to the `TradingLoop` constructor call:

```typescript
  const loop = new TradingLoop({
    // ... existing deps ...
    riskBudget,
    riskBudgetConfig: {
      riskBudgetPct: config.trading.riskBudgetPct,
      riskBudgetMaxUsd: config.trading.riskBudgetMaxUsd,
      milestoneMultiplier: config.trading.milestoneMultiplier,
      floorProtectionPct: config.trading.floorProtectionPct,
    },
  });
```

Also add startup log to show risk budget config (after the existing console.log block):

```typescript
  console.log(`Risk budget: ${config.trading.riskBudgetPct}% (max $${config.trading.riskBudgetMaxUsd}) | Floor: ${config.trading.floorProtectionPct}% | Milestone: ${config.trading.milestoneMultiplier}x`);
```

**Step 4: Update `tests/trading-loop.test.ts`**

Read the file first. If it instantiates `TradingLoop` directly with a deps object, add:

```typescript
  riskBudget: {
    update: vi.fn().mockReturnValue({
      highWaterMark: 100,
      currentFloor: 0,
      riskBudget: 10,
      dailyStartBalance: 100,
      lastResetDate: '2026-03-04',
      milestoneReached: 1,
    }),
  },
  riskBudgetConfig: {
    riskBudgetPct: 10,
    riskBudgetMaxUsd: 100,
    milestoneMultiplier: 2,
    floorProtectionPct: 95,
  },
```

**Step 5: Run all tests**

```bash
npx vitest run
```
Expected: all pass

**Step 6: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 7: Commit**

```bash
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat: wire RiskBudgetManager into trading loop and index"
```

---

### Task 5: Show risk budget in LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts` (Portfolio section, `buildEnrichedPrompt` function)
- Modify: `src/llm/prompts.ts` — `EnrichedPromptData` interface

**Context:** `buildEnrichedPrompt()` is in `src/llm/prompts.ts`. The Portfolio section starts around line 142. We need to add `riskState` as optional field to `EnrichedPromptData` and display it.

**Step 1: No test needed** — prompt output is text, not a critical invariant. Tested via integration.

**Step 2: Update `EnrichedPromptData` interface**

Add after `recentTrades?`:

```typescript
  riskState?: import('../risk/budget.js').RiskState;
```

**Step 3: Update `buildEnrichedPrompt()` Portfolio section**

After the session PnL line (`prompt += \`Session PnL: $${...}\n\``), add:

```typescript
  if (data.riskState) {
    const rs = data.riskState;
    prompt += `Risk budget: $${rs.riskBudget.toFixed(2)} remaining`;
    if (rs.currentFloor > 0) {
      prompt += ` | Floor: $${rs.currentFloor.toFixed(2)} (protect profits)`;
    }
    prompt += ` | Milestone #${rs.milestoneReached}\n`;
  }
```

**Step 4: Update `src/trading-loop.ts`** — pass `riskState` to `llm.analyze()`

In the `llm.analyze({...})` call (around line 80), add `riskState`:

```typescript
      const decisions = await llm.analyze({
        snapshots,
        indicators,
        portfolio,
        signals,
        news,
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        riskState,  // ← add this
      });
```

**Step 5: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 6: Run all tests**

```bash
npx vitest run
```
Expected: all pass

**Step 7: Commit**

```bash
git add src/llm/prompts.ts src/trading-loop.ts
git commit -m "feat: show risk budget and floor in LLM portfolio prompt"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

```bash
npx vitest run
```
Expected: all tests pass, 0 failures

**Step 2: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: 0 errors

**Step 3: Quick smoke test (optional)**

```bash
# Check that pm2 can restart without issues
pm2 restart indic-bot
pm2 logs indic-bot --lines 20
```
Look for: `Risk budget: 10% (max $100) | Floor: 95%` in startup output.

**Step 4: Commit (if any final fixes)**

```bash
git add -p
git commit -m "fix: final adjustments for risk budget feature"
```
