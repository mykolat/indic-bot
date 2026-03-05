# Trading Loop Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Fix the 3 remaining failing tests in `tests/trading-loop.test.ts` caused by incorrect mocking and hardcoded file system access.

**Architecture:** We will restore the accidentally deleted `memoryKeeper` dependency in the test setup, add the missing method mocks to `mockSessionMemory`, and update `TradingLoop` to respect the `getSoulContent` dependency before falling back to reading `soul.md` from the disk.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Fix `mockSessionMemory` in Test Setup

**Files:**
- Modify: `tests/trading-loop.test.ts` (around line 74)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**
The test `records closed trade to memory after successful CLOSE` is already failing with `TypeError: Cannot read properties of undefined (reading 'mockClear')` on `mockSessionMemory.addTrade.mockClear()`.

**Step 2: Run test to verify it fails**
```bash
npx vitest run tests/trading-loop.test.ts -t "records closed trade to memory after successful CLOSE"
```

**Step 3: Write minimal implementation**
In `tests/trading-loop.test.ts`, inside the `beforeEach` block where `mockSessionMemory` is defined, add the missing methods:
```typescript
    mockSessionMemory = {
      setStartBalance: vi.fn(),
      getStartBalance: vi.fn().mockReturnValue(100),
      getHighWaterMark: vi.fn().mockReturnValue(100),
      recordCommission: vi.fn(),
      getSessionPnlPct: vi.fn().mockReturnValue(1.5),
      getTradesRecord: vi.fn().mockReturnValue([]),
      getLastOrderResult: vi.fn().mockReturnValue(''),
      load: vi.fn().mockReturnValue({ session_notes: '', recent_trades: [] }),
      save: vi.fn(),
      logAction: vi.fn(),
      logDecision: vi.fn(),
      addTrade: vi.fn(),
      updateNotes: vi.fn(),
      setHighWaterMark: vi.fn(),
      setLastOrderResult: vi.fn(),
    } as any;
```

**Step 4: Run test to verify it passes**
```bash
npx vitest run tests/trading-loop.test.ts -t "records closed trade to memory after successful CLOSE"
```

**Step 5: Commit**
```bash
git add tests/trading-loop.test.ts
git commit -m "test: add missing mock methods to mockSessionMemory #gemini"
```

### Task 2: Fix `getStaticSoul` Hardcoding

**Files:**
- Modify: `src/trading-loop.ts` (around line 94)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**
The test `passes static soul content to llm.analyze` is currently failing in `tests/trading-loop.test.ts` because it reads real system files instead of the provided mocked string `'Trading Soul'`. 

**Step 2: Run test to verify it fails**
```bash
npx vitest run tests/trading-loop.test.ts -t "passes static soul content to llm.analyze"
```

**Step 3: Write minimal implementation**
In `src/trading-loop.ts`, update `getStaticSoul` to use the injected dependency before falling back to `fs`:

```typescript
  private getStaticSoul(): string | undefined {
    if (this.staticSoulCache) return this.staticSoulCache;

    if (this.deps.getSoulContent) {
      this.staticSoulCache = this.deps.getSoulContent();
      if (this.staticSoulCache) return this.staticSoulCache;
    }

    const soulPath = join(process.env.DATA_DIR || './data', 'soul.md');
    if (existsSync(soulPath)) {
      this.staticSoulCache = readFileSync(soulPath, 'utf8');
      return this.staticSoulCache;
    }
    return undefined;
  }
```

**Step 4: Run test to verify it passes**
```bash
npx vitest run tests/trading-loop.test.ts -t "passes static soul content to llm.analyze"
```

**Step 5: Commit**
```bash
git add src/trading-loop.ts
git commit -m "fix: prioritize getSoulContent dependency injection over real file read #gemini"
```

### Task 3: Restore Accidental Deletion of `memoryKeeper` Mock

**Files:**
- Modify: `tests/trading-loop.test.ts` (inside the `loop = new TradingLoop({...})` block)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**
The test `updates soul stats after each cycle` is currently failing in `tests/trading-loop.test.ts` because `mockMemoryKeeper.updateStats` is never called.

**Step 2: Run test to verify it fails**
```bash
npx vitest run tests/trading-loop.test.ts -t "updates soul stats after each cycle"
```

**Step 3: Write minimal implementation**
In `tests/trading-loop.test.ts`, inside the `beforeEach` block, add back `memoryKeeper` into the `TradingLoop` constructor arguments:

```typescript
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      memoryKeeper: mockMemoryKeeper as any,
      memory: mockSessionMemory,
      getSoulContent: vi.fn().mockReturnValue('Trading Soul'),
```

**Step 4: Run test to verify it passes**
```bash
npx vitest run tests/trading-loop.test.ts -t "updates soul stats after each cycle"
```

**Step 5: Commit**
```bash
git add tests/trading-loop.test.ts
git commit -m "test: restore accidentally deleted memoryKeeper mock in TradingLoop setup #gemini"
```

### Task 4: Final Suite Validation

**Step 1: Run all tests to ensure the fixes haven't broken anything else**
```bash
npx vitest run tests/trading-loop.test.ts
```

**Step 2: Final commit if tests pass cleanly**
```bash
git commit --allow-empty -m "chore: verify all trading-loop tests pass #gemini"
```
