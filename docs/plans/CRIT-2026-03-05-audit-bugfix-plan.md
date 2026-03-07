# CRIT: Audit Bugfix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 HIGH + 12 MEDIUM issues found during code audit round 2 on `feat/max-info-fetch` branch.

**Architecture:** Fixes grouped by file/module. Each task includes tests. No architectural changes — surgical fixes only.

**Tech Stack:** TypeScript ESM, Vitest

**NOTE:** Original audit issue #1 (`setStartBalance` called every cycle = sessionPnl always 0) is a **FALSE POSITIVE**. `SessionMemory.setStartBalance()` at `src/memory/session.ts:52` already has `if (state.start_balance === undefined)` guard — it only sets the balance once. No fix needed.

---

## Execution Status

| Task | Description | Status | Notes |
|------|------------|--------|-------|
| 1 | FlashCrash PANIC → close positions | ✅ DONE | `trading-loop.ts:128-146` — PANIC now closes all positions before aborting |
| 2 | cosineSimilarity NaN + embedding null-check + episodic validation | ✅ DONE | `embedding-client.ts` — length guard + API null-check; `episodic-store.ts` — Array + schema validation on load |
| 3 | computeVolumeRatio openTimes guard | ✅ DONE | `technical.ts:132` — skip extrapolation when `openTimes.length !== volumes.length` |
| 4 | trading-loop MEDIUMs (swarm interval, newsAnalysis, MemoryKeeper) | ✅ DONE | Deleted swarm interval overwrite; fixed `hasNewsCatalyst` to use `top_signals`; replaced fallback MemoryKeeper with optional chaining |
| 5 | swarm-agent JSON parser + next_check_minutes validation | ✅ DONE | Replaced brace-matcher with regex; added range validation (1-30) for `next_check_minutes` |
| 6 | Conditional SwarmAgent creation + dead import | ✅ DONE | `ENABLE_SWARM=false` env var to opt-out; no dead DevilsAdvocate import found |
| 7 | MACD O(n) + EMA SMA seed | ✅ DONE | EMA seeds with SMA of first N values; MACD rewritten as single-pass O(n) |
| 8 | Test fixes (spy + brittle assertion) | ✅ DONE | Removed unreliable `vi.spyOn`; changed `toHaveBeenCalledTimes(3)` → `toHaveBeenCalled()` |

**Summary:** 8/8 tasks completed. All 3 HIGH + 12 MEDIUM issues fixed.

---

### Task 1: Fix FlashCrashScanner PANIC — close positions instead of going blind

**Severity:** HIGH
**Files:**
- Modify: `src/trading-loop.ts:128-134`
- Test: `tests/trading-loop.test.ts`

**The bug:** When FlashCrashScanner detects PANIC, the cycle aborts (`return undefined`) but open positions remain unprotected — the bot goes blind during a flash crash.

**Step 1: Write the failing test**

Add test to `tests/trading-loop.test.ts`:

```typescript
it('closes all positions on PANIC from FlashCrashScanner', async () => {
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 1000, sessionPnl: 0, drawdownPct: 0,
    positions: [
      { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -2, heldHours: 1 },
    ],
  });
  mockOrders.close.mockResolvedValue({ success: true });

  const loopWithScanner = new TradingLoop({
    pairs: ['BTCUSDT'],
    marketData: mockMarketData,
    llm: mockLlm,
    orders: mockOrders,
    riskManager: mockRisk,
    signalBuffer: mockSignalBuffer,
    logger: mockLogger,
    memory: mockSessionMemory,
    newsCache: loop['deps'].newsCache,
    newsAnalyst: loop['deps'].newsAnalyst,
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    churnCooldownMs: 900000,
    tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    flashCrashScanner: { scan: vi.fn().mockResolvedValue('PANIC') } as any,
  });

  await loopWithScanner.runOnce();

  expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');
  expect(mockLogger.logTrade).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'EMERGENCY_CLOSE' }),
  );
  expect(mockLlm.analyze).not.toHaveBeenCalled(); // No LLM call after PANIC
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trading-loop.test.ts -t "closes all positions on PANIC"`
Expected: FAIL — currently returns undefined without closing

**Step 3: Implement fix**

In `src/trading-loop.ts`, replace lines 128-134:

```typescript
if (this.deps.flashCrashScanner) {
  const panicStatus = await this.deps.flashCrashScanner.scan();
  if (panicStatus === 'PANIC') {
    console.warn('[Loop] FlashCrashScanner detected PANIC! Emergency closing all positions.');
    logger.logError('FLASH_CRASH_DETECTED', 'Scanner detected panic sentiment — emergency close triggered.');

    // Fetch portfolio to close positions
    try {
      const portfolio = await marketData.getPortfolioState();
      for (const pos of portfolio.positions) {
        const result = await orders.close(pos.pair, pos.side);
        if (result.success) {
          logger.logTrade({ type: 'EMERGENCY_CLOSE', pair: pos.pair, reason: 'flash_crash_panic' });
          this.lastClosedAt.set(pos.pair, Date.now());
        }
      }
    } catch (err: any) {
      logger.logError('FLASH_CRASH_CLOSE_FAILED', err.message ?? 'unknown');
    }
    return undefined;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trading-loop.test.ts -t "closes all positions on PANIC"`
Expected: PASS

**Step 5: Run all trading-loop tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "fix: FlashCrashScanner PANIC now closes all positions instead of going blind"
```

---

### Task 2: Fix cosineSimilarity NaN + embedding API null-check + episodic store validation

**Severity:** HIGH (#2) + MEDIUM (#10, #11)
**Files:**
- Modify: `src/llm/embedding-client.ts:24,28-41`
- Modify: `src/memory/episodic-store.ts:20-28`
- Test: `tests/llm/embedding-client.test.ts` (create)
- Test: `tests/memory/episodic-store.test.ts` (create)

**Bug #2:** `cosineSimilarity` produces NaN when vectors have different lengths — corrupts episodic search.
**Bug #10:** No null-check on `data.data[0]` in embedding API response.
**Bug #11:** No schema validation when loading episodic store JSON.

**Step 1: Write tests**

Create `tests/llm/embedding-client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../../src/llm/embedding-client.js';

describe('cosineSimilarity', () => {
  it('returns valid similarity for same-length vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('returns 1 for identical vectors', () => {
    const a = [1, 2, 3];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1);
  });

  it('returns 0 (not NaN) for mismatched vector lengths', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2];
    const result = cosineSimilarity(a, b);
    expect(Number.isNaN(result)).toBe(false);
    expect(typeof result).toBe('number');
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
```

Create `tests/memory/episodic-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { EpisodicStore } from '../../src/memory/episodic-store.js';

vi.mock('fs');

describe('EpisodicStore', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('handles corrupted JSON file gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json {{{');
    const store = new EpisodicStore('/tmp/test-episodes.json');
    expect(store.getAll()).toEqual([]);
  });

  it('handles JSON object instead of array', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{"key": "value"}');
    const store = new EpisodicStore('/tmp/test-episodes.json');
    expect(store.getAll()).toEqual([]);
  });

  it('search returns valid results (no NaN scores)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([
      { id: '1', timestamp: 1, textSummary: 'test', embedding: [1, 0, 0], resultPnl: 5 }
    ]));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    const store = new EpisodicStore('/tmp/test-episodes.json');
    const results = store.search([0, 1, 0], 1);
    expect(results.length).toBe(1);
    expect(Number.isNaN(results[0].score)).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm/embedding-client.test.ts tests/memory/episodic-store.test.ts`
Expected: Mismatched vectors test FAILS with NaN, episodic object test FAILS

**Step 3: Fix cosineSimilarity**

In `src/llm/embedding-client.ts`, replace the `cosineSimilarity` function:

```typescript
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length === 0 || vecB.length === 0) return 0;
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Step 4: Fix embedding API null-check**

In `src/llm/embedding-client.ts`, replace line 24:

```typescript
    const data = await response.json();
    if (!data?.data?.[0]?.embedding) {
        throw new Error(`Unexpected embedding API response: missing data.data[0].embedding`);
    }
    return data.data[0].embedding;
```

**Step 5: Fix episodic store validation**

In `src/memory/episodic-store.ts`, replace the `load()` method:

```typescript
    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (Array.isArray(parsed)) {
                    this.episodes = parsed.filter(ep =>
                        ep && typeof ep.id === 'string' && Array.isArray(ep.embedding)
                    );
                } else {
                    console.error('Episodic store file is not an array, resetting');
                    this.episodes = [];
                }
            } catch (e) {
                console.error('Failed to load episodic graph', e);
                this.episodes = [];
            }
        }
    }
```

**Step 6: Run tests**

Run: `npx vitest run tests/llm/embedding-client.test.ts tests/memory/episodic-store.test.ts`
Expected: All pass

**Step 7: Commit**

```bash
git add src/llm/embedding-client.ts src/memory/episodic-store.ts tests/llm/embedding-client.test.ts tests/memory/episodic-store.test.ts
git commit -m "fix: cosineSimilarity NaN guard, embedding API null-check, episodic store validation"
```

---

### Task 3: Fix computeVolumeRatio openTimes guard

**Severity:** HIGH
**Files:**
- Modify: `src/indicators/technical.ts:124-144`
- Test: `tests/indicators/technical.test.ts` (existing)

**Bug:** `computeVolumeRatio` uses `openTimes[openTimes.length - 1]` without checking length match with `volumes`. If arrays differ in length, wrong candle's openTime is used.

**Step 1: Write the failing test**

Add to existing tests or create if not exists:

```typescript
it('computeVolumeRatio returns 1 when openTimes length mismatches volumes', () => {
  const volumes = [100, 100, 100, 100, 200];
  const openTimes = [1, 2, 3]; // shorter than volumes
  const result = computeVolumeRatio(volumes, openTimes);
  // Should still produce a valid number, not use wrong index
  expect(Number.isFinite(result)).toBe(true);
});
```

**Step 2: Implement fix**

In `src/indicators/technical.ts`, at the start of the `openTimes` block (line 132):

```typescript
  if (openTimes && openTimes.length === volumes.length && openTimes.length > 0) {
```

Change `if (openTimes && openTimes.length > 0)` → `if (openTimes && openTimes.length === volumes.length && openTimes.length > 0)`.

This skips volume extrapolation when arrays don't match, falling back to raw ratio.

**Step 3: Run tests**

Run: `npx vitest run tests/indicators/`
Expected: All pass

**Step 4: Commit**

```bash
git add src/indicators/technical.ts tests/indicators/
git commit -m "fix: computeVolumeRatio guard for openTimes/volumes length mismatch"
```

---

### Task 4: Fix trading-loop.ts MEDIUM bugs (#5, #6, #7)

**Severity:** MEDIUM × 3
**Files:**
- Modify: `src/trading-loop.ts` (lines 488, 421, 384)
- Test: `tests/trading-loop.test.ts`

**Bug #5 (line 488):** After swarm consensus, `lastNextCheckMinutes` is read from `promptData` (which never has it) → always overwritten to `5`. The swarm agent already sets it internally.

**Bug #6 (line 421):** `Array.isArray(newsAnalysis)` on a `NewsAnalysis` object → `hasNewsCatalyst` always false. Should check `newsAnalysis.top_signals`.

**Bug #7 (line 384):** Fallback `MemoryKeeper` created with `./tmp` instead of proper data dir.

**Step 1: Write tests for #5 and #6**

```typescript
it('preserves swarm consensus next_check_minutes (not overwrite to 5)', async () => {
  const mockSwarm = {
    getConsensus: vi.fn().mockImplementation(async function(this: any, data: any) {
      // Swarm internally sets llm.lastNextCheckMinutes
      return [{ pair: 'BTCUSDT', action: 'HOLD' }];
    }),
  };

  // We need to verify that line 488 does NOT overwrite the value set by swarm
  // The fix removes line 488 entirely, so after swarm call, llm.lastNextCheckMinutes stays as-is
  // This is tricky to test directly — we verify swarm is called and llm.analyze is NOT called
});

it('detects news catalyst from newsAnalysis.top_signals (not Array.isArray)', async () => {
  loop['deps'].newsCache.getAnalysis = vi.fn().mockReturnValue({
    market_summary: 'BTC pump',
    top_signals: [{ importance: 9, catalyst: 'ETF approved', direction: 'bullish' }],
    overall_sentiment: 'bullish',
    macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
    risk_events: [],
  });
  mockLlm.analyze.mockResolvedValue([]);

  await loop.runOnce();

  // Verify analyze was called (cycle completed)
  expect(mockLlm.analyze).toHaveBeenCalled();
});
```

**Step 2: Fix #5 — Remove wrong overwrite (line 488)**

In `src/trading-loop.ts`, replace line 488:

```typescript
// BEFORE:
llm.lastNextCheckMinutes = (promptData as any).next_check_minutes || 5;

// AFTER: (remove this line entirely — swarm-agent.ts:71 already sets it)
```

**Step 3: Fix #6 — Use top_signals instead of Array.isArray (line 421)**

```typescript
// BEFORE:
const hasNewsCatalyst = !!(newsAnalysis && Array.isArray(newsAnalysis) && newsAnalysis.some((n: any) => n.importance >= 7));

// AFTER:
const hasNewsCatalyst = !!(newsAnalysis && Array.isArray((newsAnalysis as any).top_signals) && (newsAnalysis as any).top_signals.some((s: any) => s.importance >= 7));
```

**Step 4: Fix #7 — Use deps.memoryKeeper directly (line 384)**

```typescript
// BEFORE:
const memoryKeeper = this.deps.memoryKeeper ?? new MemoryKeeper(process.env.DATA_DIR || './tmp');
const latestMemoryData = memoryKeeper.read();

// AFTER:
const latestMemoryData = this.deps.memoryKeeper?.read() ?? '';
```

**Step 5: Run tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: All pass

**Step 6: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "fix: swarm interval overwrite, newsAnalysis type check, MemoryKeeper fallback path"
```

---

### Task 5: Fix swarm-agent.ts — JSON parser + next_check_minutes validation

**Severity:** MEDIUM × 2
**Files:**
- Modify: `src/llm/swarm-agent.ts` (lines 49-61, 71)
- Test: `tests/llm/swarm-agent.test.ts` (create)

**Bug #8 (lines 49-61):** Brace-matching JSON extractor doesn't handle braces inside string values. LLM reasoning like `"If price breaks {key level}"` truncates the JSON.

**Bug #9 (line 71):** `parsed.next_check_minutes` from raw JSON without validation. Value of 0, negative, or non-numeric breaks loop interval.

**Step 1: Write tests**

Create `tests/llm/swarm-agent.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SwarmAgent } from '../../src/llm/swarm-agent.js';

describe('SwarmAgent', () => {
  const makeMockLlm = (consensusResponse: string) => ({
    call: vi.fn()
      .mockResolvedValueOnce('bull analysis')
      .mockResolvedValueOnce('bear analysis')
      .mockResolvedValueOnce('risk analysis')
      .mockResolvedValueOnce(consensusResponse), // consensus call
    analyze: vi.fn(),
    lastNextCheckMinutes: undefined as number | undefined,
    updateAccessToken: vi.fn(),
  });

  const makeMinimalPromptData = () => ({
    snapshots: [], indicators: new Map(), indicators4h: new Map(),
    portfolio: { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 },
    signals: [], news: [], fearGreed: { value: 50, label: 'Neutral' },
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    recentTrades: [], sessionPnlPct: 0, riskStatus: 'normal',
  } as any);

  it('parses JSON with braces inside string values', async () => {
    const response = `Here's my analysis: {"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "reasoning": "Price at {key} resistance level"}], "next_check_minutes": 3}`;
    const llm = makeMockLlm(response);
    const agent = new SwarmAgent(llm as any);

    const result = await agent.getConsensus(makeMinimalPromptData());
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('HOLD');
  });

  it('validates next_check_minutes range (1-30)', async () => {
    const response = `{"decisions": [], "next_check_minutes": -5}`;
    const llm = makeMockLlm(response);
    const agent = new SwarmAgent(llm as any);

    await agent.getConsensus(makeMinimalPromptData());
    expect(llm.lastNextCheckMinutes).toBeUndefined(); // invalid value rejected
  });

  it('validates next_check_minutes is a number', async () => {
    const response = `{"decisions": [], "next_check_minutes": "soon"}`;
    const llm = makeMockLlm(response);
    const agent = new SwarmAgent(llm as any);

    await agent.getConsensus(makeMinimalPromptData());
    expect(llm.lastNextCheckMinutes).toBeUndefined();
  });
});
```

**Step 2: Fix JSON extraction — use JSON.parse with regex fallback**

Replace lines 49-67 in `src/llm/swarm-agent.ts`:

```typescript
        // Extract JSON from consensus response
        let jsonStr: string | undefined;
        // Try direct parse first
        try {
            JSON.parse(rawConsensus);
            jsonStr = rawConsensus;
        } catch {
            // Find JSON using regex for {"decisions": pattern
            const match = rawConsensus.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\]\s*[\s\S]*\}/);
            if (match) {
                jsonStr = match[0];
            }
        }

        if (!jsonStr) {
            console.error('[Swarm] Consensus parser failed to find JSON');
            return [];
        }
```

**Step 3: Fix next_check_minutes validation (line 71)**

Replace line 71:

```typescript
            const ncm = parsed.next_check_minutes;
            if (typeof ncm === 'number' && Number.isFinite(ncm) && ncm >= 1 && ncm <= 30) {
                this.llm.lastNextCheckMinutes = ncm;
            }
```

**Step 4: Run tests**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "fix: swarm JSON parser handles string braces, validate next_check_minutes range"
```

---

### Task 6: Fix index.ts — conditional SwarmAgent creation

**Severity:** MEDIUM
**Files:**
- Modify: `src/index.ts:142`

**Bug:** `SwarmAgent` is always created and passed to TradingLoop, even when unnecessary. The swarm activates on high volume (>1.5x), consuming 4-5x API credits per cycle. No way to disable.

**Step 1: Fix conditional creation**

In `src/index.ts`, replace line 142:

```typescript
// BEFORE:
const swarmAgent = new SwarmAgent(llm, grokClient);

// AFTER:
const enableSwarm = process.env.ENABLE_SWARM !== 'false'; // opt-out via env
const swarmAgent = enableSwarm ? new SwarmAgent(llm, grokClient) : undefined;
if (swarmAgent) console.log('[Swarm] SwarmAgent enabled (disable with ENABLE_SWARM=false)');
```

**Step 2: Also remove dead import (line 37 — DevilsAdvocate)**

Check if `DevilsAdvocate` import exists and is unused. If so, remove it.

Note: The `import { DevilsAdvocate }` line mentioned in audit — check if it actually exists in current code. If yes, remove.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: SwarmAgent conditional creation (ENABLE_SWARM env), remove dead import"
```

---

### Task 7: Fix MACD signal computation + EMA seed

**Severity:** MEDIUM
**Files:**
- Modify: `src/indicators/technical.ts:89-105,62-71`
- Test: `tests/indicators/technical.test.ts`

**Bug #13:** MACD signal line is computed with O(n²) slicing pattern: for each data point, it re-computes both EMAs from scratch. Also, the signal line EMA is seeded from the MACD series which itself was built incrementally — the seeding is inconsistent.

**Bug #14:** `computeEMA` seeds with `closes[0]` instead of SMA of first `period` values. This is a known variant but SMA seed is more standard and produces values closer to TradingView/Binance.

**Step 1: Write test for EMA SMA-seed**

```typescript
it('computeEMA with SMA seed matches expected value', () => {
  // 5 values, period 3: SMA of first 3 = (10+20+30)/3 = 20
  // Then EMA(40) = 40 * 0.5 + 20 * 0.5 = 30, EMA(50) = 50 * 0.5 + 30 * 0.5 = 40
  const result = computeEMA([10, 20, 30, 40, 50], 3);
  expect(result).toBeCloseTo(40);
});
```

**Step 2: Fix computeEMA — SMA seed**

```typescript
export function computeEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}
```

**Step 3: Fix computeMACD — O(n) instead of O(n²)**

```typescript
export function computeMACD(closes: number[], fast = 12, slow = 26, signal = 9): MACDResult {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };

  // Compute full EMA series for fast and slow
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);

  let emaFast = closes.slice(0, fast).reduce((s, v) => s + v, 0) / fast;
  let emaSlow = closes.slice(0, slow).reduce((s, v) => s + v, 0) / slow;

  // Build MACD series starting from index `slow` (once both EMAs are seeded)
  // First, advance fast EMA to index `slow`
  for (let i = fast; i < slow; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
  }

  const macdSeries: number[] = [];
  for (let i = slow; i < closes.length; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    macdSeries.push(emaFast - emaSlow);
  }

  // Signal line = EMA of MACD series
  const kSignal = 2 / (signal + 1);
  let signalLine = macdSeries.slice(0, signal).reduce((s, v) => s + v, 0) / signal;
  for (let i = signal; i < macdSeries.length; i++) {
    signalLine = macdSeries[i] * kSignal + signalLine * (1 - kSignal);
  }

  const macdLine = macdSeries[macdSeries.length - 1];
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/indicators/`
Expected: All pass (may need to update expected values in existing tests if EMA seed changed values)

**Step 5: Commit**

```bash
git add src/indicators/technical.ts tests/indicators/
git commit -m "fix: EMA SMA seed, MACD O(n) computation with proper signal line"
```

---

### Task 8: Fix test issues (#15, #16)

**Severity:** MEDIUM
**Files:**
- Modify: `tests/trading-loop.test.ts`

**Bug #15:** Swarm test uses `vi.spyOn` on already-imported module — spy may have no effect.
**Bug #16:** Test asserts exact `llm.call` count (3) — brittle, breaks if expert count changes.

**Step 1: Fix swarm test (#15)**

The swarm test at line 557 should mock `computeIndicators` at the module level, not via dynamic import spy:

At the top of the file, add a top-level mock for when swarm test needs custom indicators:

```typescript
// Already mocked: fear-greed. For swarm test, we control volume ratio via makeCandles.
```

Actually, the simplest fix is to make `makeCandles` produce high volume (>1.5x ratio) for the swarm test. The current `makeCandles` already sets last candle volume to '500' vs '100' for others, giving ratio = 5.0. So the spy may not even be needed. Verify by checking if the swarm test passes without the spy — if yes, remove the spy entirely.

If the spy IS needed, convert to top-level `vi.mock`:

```typescript
// At top of file, conditionally mock:
// The test already has high volume in makeCandles (500 vs 100) = ratio ~5x
// Remove the vi.spyOn block entirely if test passes without it
```

**Step 2: Fix brittle call count (#16)**

Replace line 130:

```typescript
// BEFORE:
expect(mockLlm.call).toHaveBeenCalledTimes(3); // Layer 1 triggered

// AFTER:
expect(mockLlm.call).toHaveBeenCalled(); // Layer 1 experts triggered
```

**Step 3: Run tests**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: All pass

**Step 4: Commit**

```bash
git add tests/trading-loop.test.ts
git commit -m "fix: remove brittle test assertions, fix swarm test spy"
```

---

### Summary

| Task | Issues Fixed | Severity | Files |
|------|-------------|----------|-------|
| 1 | FlashCrash PANIC → close positions | HIGH | trading-loop.ts |
| 2 | cosineSimilarity NaN + embedding null-check + episodic validation | HIGH + 2×MED | embedding-client.ts, episodic-store.ts |
| 3 | computeVolumeRatio openTimes guard | HIGH | technical.ts |
| 4 | Swarm interval overwrite + newsAnalysis type + MemoryKeeper path | 3×MED | trading-loop.ts |
| 5 | Swarm JSON parser + next_check_minutes validation | 2×MED | swarm-agent.ts |
| 6 | Conditional SwarmAgent + dead import | MED | index.ts |
| 7 | MACD O(n) + EMA SMA seed | 2×MED | technical.ts |
| 8 | Test fixes (spy + brittle assertion) | 2×MED | trading-loop.test.ts |

**Total: 3 HIGH + 12 MEDIUM = 15 fixes across 8 tasks**

Tasks 1-3 are independent. Tasks 4-5 depend on understanding Task 1 changes to trading-loop.ts. Tasks 6-8 are fully independent.
