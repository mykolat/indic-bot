# Issue #13: Watchdog anomalies don't wake Brain — up to 30 min delay

## Problem

When the Watchdog detects a price spike (>2%) or OI spike (>10%), it fires the `onAnomaly` callback which currently only logs the event (`src/index.ts:266-269`). Brain continues sleeping until its next scheduled `setTimeout` fires (10-30 min default). In volatile markets, this delay is unacceptable.

**Current flow** (`src/index.ts:280-305`):
```
runCycle() → loop.runOnce() → setTimeout(runCycle, nextMs)
```
There is no mechanism for Watchdog to interrupt or reschedule the sleeping Brain.

**Current anomaly handler** (`src/index.ts:266-269`):
```typescript
onAnomaly: (pair, type, detail) => {
  console.log(`[Watchdog] ANOMALY ${pair} ${type}: ${detail}`);
  logger.logError('WATCHDOG_ANOMALY', `${pair} ${type}: ${detail}`);
},
```
It logs but does not trigger `runCycle()`.

## Solution

Use Node.js `EventEmitter` pattern. Watchdog extends `EventEmitter` and emits `'anomaly'` events. `index.ts` listens for them and triggers an early `runCycle()` with debounce (min 30 s between anomaly-triggered cycles).

### Key Design Decisions

1. **Watchdog extends EventEmitter** — cleaner than callback-only pattern; supports multiple listeners; backward-compatible (existing `onAnomaly` callback kept as sugar)
2. **Debounce in index.ts, not Watchdog** — Watchdog should emit all anomalies; the consumer decides policy
3. **Cancel pending setTimeout** — store the `timeoutId` so anomaly handler can `clearTimeout` and reschedule
4. **Anomaly flag in runOnce** — pass `{ triggeredBy: 'anomaly' }` so Brain knows this is an urgent cycle (logged, not behavioral change yet)

## Files Changed

| File | Change |
|---|---|
| `src/watchdog.ts` | Extend `EventEmitter`, emit `'anomaly'` event with structured payload |
| `src/index.ts` | Listen for `'anomaly'`, debounce + cancel pending timer, trigger early `runCycle()` |
| `tests/watchdog.test.ts` | New tests for EventEmitter behavior |
| `tests/watchdog-wake.test.ts` | New test file for debounce/scheduling integration |

## Interfaces

```typescript
// src/watchdog.ts — new event payload
export interface AnomalyEvent {
  pair: string;
  type: 'PRICE_SPIKE' | 'OI_SPIKE';
  detail: string;
  timestamp: number;
}
```

---

## Step 1: Test that Watchdog extends EventEmitter and emits 'anomaly' events

### 1a. Write failing test

**File:** `tests/watchdog.test.ts`

Add a new test after the existing `'fires onAnomaly for price spike > 2%'` test (line 94):

```typescript
import { EventEmitter } from 'events';

// ... inside describe('Watchdog', () => { ... })

  it('extends EventEmitter and emits anomaly event on price spike', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 68000,
      open_interest: 50000,
      funding_rate: 0.0001,
    });
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });

    expect(wd).toBeInstanceOf(EventEmitter);

    const events: any[] = [];
    wd.on('anomaly', (e) => events.push(e));

    await wd.tick();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      pair: 'BTCUSDT',
      type: 'PRICE_SPIKE',
      detail: expect.stringContaining('%'),
      timestamp: expect.any(Number),
    });
  });

  it('emits anomaly event on OI spike > 10%', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 70000,
      open_interest: 40000,
      funding_rate: 0.0001,
    });
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });

    const events: any[] = [];
    wd.on('anomaly', (e) => events.push(e));

    await wd.tick();

    expect(events.some(e => e.type === 'OI_SPIKE')).toBe(true);
  });

  it('still calls legacy onAnomaly callback alongside emitting event', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 68000,
      open_interest: 50000,
      funding_rate: 0.0001,
    });
    const onAnomaly = vi.fn();
    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
      onAnomaly,
    });

    const events: any[] = [];
    wd.on('anomaly', (e) => events.push(e));

    await wd.tick();

    // Both mechanisms fire
    expect(onAnomaly).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });
```

### 1b. Run and verify failure

```bash
npx vitest run tests/watchdog.test.ts
```

Expected failures:
- `Watchdog` is not an `EventEmitter` — `expect(wd).toBeInstanceOf(EventEmitter)` fails
- No `'anomaly'` event emitted — `events` array is empty

### 1c. Implement

**File:** `src/watchdog.ts`

```typescript
import { EventEmitter } from 'events';
import type { MarketDataFetcher, QuickSnapshot } from './binance/market-data.js';
import type { DbMarketSnapshot } from './db/types.js';

export interface AnomalyEvent {
  pair: string;
  type: 'PRICE_SPIKE' | 'OI_SPIKE';
  detail: string;
  timestamp: number;
}

export interface WatchdogDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  sessionId: string;
  insertSnapshot: (s: Omit<DbMarketSnapshot, 'id' | 'created_at'>) => Promise<number>;
  getLatestSnapshot: (pair: string) => Promise<DbMarketSnapshot | null>;
  onAnomaly?: (pair: string, type: string, detail: string) => void;
}

export class Watchdog extends EventEmitter {
  private deps: WatchdogDeps;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WatchdogDeps) {
    super();
    this.deps = deps;
  }

  start(intervalMs = 60_000): void {
    console.log(`[Watchdog] Starting — ${this.deps.pairs.length} pairs, every ${intervalMs / 1000}s`);
    this.intervalId = setInterval(() => this.tick().catch(e => console.error('[Watchdog] tick error:', e.message)), intervalMs);
    this.tick().catch(e => console.error('[Watchdog] initial tick error:', e.message));
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(): Promise<void> {
    const results = await Promise.allSettled(
      this.deps.pairs.map(pair => this.processPair(pair)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[Watchdog] pair tick failed:', r.reason);
      }
    }
  }

  private async processPair(pair: string): Promise<void> {
    const snap = await this.deps.marketData.getQuickSnapshot(pair);
    const prev = await this.deps.getLatestSnapshot(pair);
    const current = this.extractFields(snap);

    if (prev && !this.hasChanged(prev, current)) {
      return;
    }

    await this.deps.insertSnapshot({
      session_id: this.deps.sessionId,
      ...current,
    });

    if (prev) {
      const priceDelta = Math.abs(current.mark_price - Number(prev.mark_price)) / Number(prev.mark_price) * 100;
      if (priceDelta > 2) {
        const detail = `${priceDelta.toFixed(1)}% in 1 min`;
        this.deps.onAnomaly?.(pair, 'PRICE_SPIKE', detail);
        this.emit('anomaly', { pair, type: 'PRICE_SPIKE', detail, timestamp: Date.now() } as AnomalyEvent);
      }
      if (prev.open_interest && current.open_interest) {
        const oiDelta = Math.abs(current.open_interest - Number(prev.open_interest)) / Number(prev.open_interest) * 100;
        if (oiDelta > 10) {
          const detail = `${oiDelta.toFixed(1)}% change`;
          this.deps.onAnomaly?.(pair, 'OI_SPIKE', detail);
          this.emit('anomaly', { pair, type: 'OI_SPIKE', detail, timestamp: Date.now() } as AnomalyEvent);
        }
      }
    }
  }

  private extractFields(snap: QuickSnapshot): Omit<DbMarketSnapshot, 'id' | 'created_at' | 'session_id'> {
    return {
      pair: snap.pair,
      mark_price: parseFloat(snap.markPrice),
      open_interest: parseFloat(snap.openInterest),
      funding_rate: parseFloat(snap.fundingRate),
      long_short_ratio: snap.longShortRatio ?? undefined,
      order_book_bid_pct: snap.orderBookBidPct,
      order_book_ask_pct: snap.orderBookAskPct,
      imbalance_pct: snap.imbalancePct,
    };
  }

  private hasChanged(prev: DbMarketSnapshot, current: Omit<DbMarketSnapshot, 'id' | 'created_at' | 'session_id'>): boolean {
    if (Number(prev.mark_price) !== current.mark_price) return true;
    if (Number(prev.open_interest) !== current.open_interest) return true;
    if (Number(prev.funding_rate) !== current.funding_rate) return true;
    if (Number(prev.long_short_ratio) !== current.long_short_ratio) return true;
    if (Number(prev.order_book_bid_pct) !== current.order_book_bid_pct) return true;
    return false;
  }
}
```

**Key changes:**
- Line 1: `import { EventEmitter } from 'events';`
- Line 7-12: New `AnomalyEvent` interface
- Line 22: `export class Watchdog extends EventEmitter`
- Line 26: `super()` call in constructor
- Lines 70-82: Anomaly detection refactored — always emits `'anomaly'` event, calls `onAnomaly` callback via optional chaining. The `if (prev && this.deps.onAnomaly)` guard is split: `prev` check stays, `onAnomaly` is now optional via `?.`

### 1d. Run and verify pass

```bash
npx vitest run tests/watchdog.test.ts
```

All existing tests pass (backward compatible). New EventEmitter tests pass.

### 1e. Commit

```bash
git add src/watchdog.ts tests/watchdog.test.ts
git commit -m "feat(watchdog): extend EventEmitter, emit 'anomaly' events"
```

---

## Step 2: Test debounced Brain wake on anomaly event

### 2a. Write failing test

**File:** `tests/watchdog-wake.test.ts` (new file)

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watchdog, type AnomalyEvent } from '../src/watchdog.js';

describe('Watchdog -> Brain wake (debounce)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWatchdog(): Watchdog {
    return new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: { getQuickSnapshot: vi.fn() } as any,
      sessionId: 'test',
      insertSnapshot: vi.fn().mockResolvedValue(1),
      getLatestSnapshot: vi.fn().mockResolvedValue(null),
    });
  }

  it('first anomaly triggers immediate Brain wake', () => {
    const wd = createWatchdog();
    const wakeFn = vi.fn();
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastAnomalyWake = 0;
    const DEBOUNCE_MS = 30_000;

    wd.on('anomaly', (_event: AnomalyEvent) => {
      const now = Date.now();
      if (now - lastAnomalyWake >= DEBOUNCE_MS) {
        lastAnomalyWake = now;
        if (pendingTimer) clearTimeout(pendingTimer);
        wakeFn();
      }
    });

    wd.emit('anomaly', {
      pair: 'BTCUSDT',
      type: 'PRICE_SPIKE',
      detail: '3.2% in 1 min',
      timestamp: Date.now(),
    } as AnomalyEvent);

    expect(wakeFn).toHaveBeenCalledOnce();
  });

  it('second anomaly within 30s is debounced', () => {
    const wd = createWatchdog();
    const wakeFn = vi.fn();
    let lastAnomalyWake = 0;
    const DEBOUNCE_MS = 30_000;

    wd.on('anomaly', (_event: AnomalyEvent) => {
      const now = Date.now();
      if (now - lastAnomalyWake >= DEBOUNCE_MS) {
        lastAnomalyWake = now;
        wakeFn();
      }
    });

    // First anomaly — triggers
    wd.emit('anomaly', {
      pair: 'BTCUSDT', type: 'PRICE_SPIKE',
      detail: '3.2%', timestamp: Date.now(),
    } as AnomalyEvent);
    expect(wakeFn).toHaveBeenCalledTimes(1);

    // 15s later — second anomaly, should be debounced
    vi.advanceTimersByTime(15_000);
    wd.emit('anomaly', {
      pair: 'BTCUSDT', type: 'OI_SPIKE',
      detail: '12%', timestamp: Date.now(),
    } as AnomalyEvent);
    expect(wakeFn).toHaveBeenCalledTimes(1); // still 1

    // 31s after first — third anomaly, should trigger
    vi.advanceTimersByTime(16_000);
    wd.emit('anomaly', {
      pair: 'ETHUSDT', type: 'PRICE_SPIKE',
      detail: '4.1%', timestamp: Date.now(),
    } as AnomalyEvent);
    expect(wakeFn).toHaveBeenCalledTimes(2);
  });

  it('anomaly wake cancels pending scheduled timer', () => {
    const wd = createWatchdog();
    const scheduledFn = vi.fn();
    const wakeFn = vi.fn();
    let lastAnomalyWake = 0;
    const DEBOUNCE_MS = 30_000;

    // Simulate a scheduled Brain cycle in 10 minutes
    let pendingTimer: ReturnType<typeof setTimeout> | null = setTimeout(scheduledFn, 600_000);

    wd.on('anomaly', (_event: AnomalyEvent) => {
      const now = Date.now();
      if (now - lastAnomalyWake >= DEBOUNCE_MS) {
        lastAnomalyWake = now;
        // Cancel pending scheduled cycle
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        wakeFn();
        // Reschedule for later (simulating what index.ts would do)
        pendingTimer = setTimeout(scheduledFn, 600_000);
      }
    });

    // Anomaly fires after 2 minutes
    vi.advanceTimersByTime(120_000);
    wd.emit('anomaly', {
      pair: 'BTCUSDT', type: 'PRICE_SPIKE',
      detail: '5.0%', timestamp: Date.now(),
    } as AnomalyEvent);

    expect(wakeFn).toHaveBeenCalledOnce();
    // The original scheduled timer should NOT have fired (it was at 10min, we're at 2min)
    expect(scheduledFn).not.toHaveBeenCalled();

    // Advance past original 10-min mark — original timer was canceled
    vi.advanceTimersByTime(500_000);
    expect(scheduledFn).not.toHaveBeenCalled();

    // Advance to new schedule time (10 min from anomaly wake)
    vi.advanceTimersByTime(200_000);
    expect(scheduledFn).toHaveBeenCalledOnce();
  });
});
```

### 2b. Run and verify pass

```bash
npx vitest run tests/watchdog-wake.test.ts
```

These tests validate the debounce logic pattern that will be used in `index.ts`. They should pass immediately since they test the EventEmitter + debounce pattern using the new `Watchdog extends EventEmitter` from Step 1.

**Note:** If Step 1 is not yet implemented, these tests fail because `Watchdog` is not an `EventEmitter`. That's expected — Step 1 must be done first.

### 2c. Commit

```bash
git add tests/watchdog-wake.test.ts
git commit -m "test: debounce logic for watchdog-triggered Brain wake"
```

---

## Step 3: Wire anomaly -> Brain wake in index.ts

### 3a. No unit test (integration wiring)

This step modifies `src/index.ts` which is the entry point and not unit-testable. The debounce logic was validated in Step 2. This is pure wiring.

### 3b. Implement

**File:** `src/index.ts`

**Change 1:** Replace the `onAnomaly` callback and add EventEmitter listener after watchdog creation (lines 258-273).

Replace:
```typescript
  // Start Watchdog (1-min snapshots into DB)
  let watchdog: Watchdog | undefined;
  if (sessionId) {
    watchdog = new Watchdog({
      pairs: config.trading.pairs,
      marketData,
      sessionId,
      insertSnapshot: insertMarketSnapshot,
      getLatestSnapshot: getLatestMarketSnapshot,
      onAnomaly: (pair, type, detail) => {
        console.log(`[Watchdog] ANOMALY ${pair} ${type}: ${detail}`);
        logger.logError('WATCHDOG_ANOMALY', `${pair} ${type}: ${detail}`);
      },
    });
    watchdog.start(60_000);
    console.log('[Watchdog] Started — 1-min market snapshots');
  }
```

With:
```typescript
  // Start Watchdog (1-min snapshots into DB)
  let watchdog: Watchdog | undefined;
  if (sessionId) {
    watchdog = new Watchdog({
      pairs: config.trading.pairs,
      marketData,
      sessionId,
      insertSnapshot: insertMarketSnapshot,
      getLatestSnapshot: getLatestMarketSnapshot,
      onAnomaly: (pair, type, detail) => {
        console.log(`[Watchdog] ANOMALY ${pair} ${type}: ${detail}`);
        logger.logError('WATCHDOG_ANOMALY', `${pair} ${type}: ${detail}`);
      },
    });
    watchdog.start(60_000);
    console.log('[Watchdog] Started — 1-min market snapshots');
  }

  // Anomaly-triggered Brain wake (debounced)
  const ANOMALY_DEBOUNCE_MS = 30_000;
  let lastAnomalyWake = 0;
```

**Change 2:** Store `timeoutId` so it can be canceled. Replace the scheduling section (lines 278-305).

Replace:
```typescript
  const defaultIntervalMs = config.trading.loopIntervalMs;

  const runCycle = async () => {
    if (loop.isShutdown()) {
      console.log('\n*** BOT SHUTDOWN — max loss reached ***');
      process.exit(0);
    }

    // Auto-refresh OAuth token if needed (getOpenAIAccessToken returns cached or refreshes)
    try {
      const freshToken = await getOpenAIAccessToken();
      llm.updateAccessToken(freshToken);
    } catch (err: any) {
      console.warn('[Auth] Token refresh skipped:', err.message);
    }

    console.log(`\n--- Cycle at ${new Date().toISOString()} ---`);
    const nextCheckMinutes = await loop.runOnce();

    // Dynamic interval: LLM suggests next check, fallback to config default
    const minBrainMs = 10 * 60_000; // 10 min minimum for Brain without positions
    const hasPositions = loop.hasOpenPositions?.() ?? false;
    const effectiveMin = hasPositions ? defaultIntervalMs : minBrainMs;
    const nextMs = nextCheckMinutes
      ? Math.max(nextCheckMinutes * 60_000, effectiveMin)
      : effectiveMin;
    setTimeout(runCycle, nextMs);
  };

  // Run first cycle immediately
  await runCycle();
```

With:
```typescript
  const defaultIntervalMs = config.trading.loopIntervalMs;
  let brainTimer: ReturnType<typeof setTimeout> | null = null;
  let brainRunning = false;

  const scheduleBrain = (ms: number) => {
    if (brainTimer) clearTimeout(brainTimer);
    brainTimer = setTimeout(runCycle, ms);
  };

  const runCycle = async () => {
    if (loop.isShutdown()) {
      console.log('\n*** BOT SHUTDOWN — max loss reached ***');
      process.exit(0);
    }

    brainRunning = true;

    // Auto-refresh OAuth token if needed (getOpenAIAccessToken returns cached or refreshes)
    try {
      const freshToken = await getOpenAIAccessToken();
      llm.updateAccessToken(freshToken);
    } catch (err: any) {
      console.warn('[Auth] Token refresh skipped:', err.message);
    }

    console.log(`\n--- Cycle at ${new Date().toISOString()} ---`);
    const nextCheckMinutes = await loop.runOnce();

    brainRunning = false;

    // Dynamic interval: LLM suggests next check, fallback to config default
    const minBrainMs = 10 * 60_000; // 10 min minimum for Brain without positions
    const hasPositions = loop.hasOpenPositions?.() ?? false;
    const effectiveMin = hasPositions ? defaultIntervalMs : minBrainMs;
    const nextMs = nextCheckMinutes
      ? Math.max(nextCheckMinutes * 60_000, effectiveMin)
      : effectiveMin;
    scheduleBrain(nextMs);
  };

  // Anomaly listener: wake Brain early (debounced)
  if (watchdog) {
    watchdog.on('anomaly', (event) => {
      const now = Date.now();
      if (brainRunning) {
        console.log(`[Anomaly->Brain] Skipped — Brain already running (${event.pair} ${event.type})`);
        return;
      }
      if (now - lastAnomalyWake < ANOMALY_DEBOUNCE_MS) {
        console.log(`[Anomaly->Brain] Debounced — ${((ANOMALY_DEBOUNCE_MS - (now - lastAnomalyWake)) / 1000).toFixed(0)}s cooldown remaining (${event.pair} ${event.type})`);
        return;
      }
      lastAnomalyWake = now;
      console.log(`[Anomaly->Brain] WAKING Brain early — ${event.pair} ${event.type}: ${event.detail}`);
      scheduleBrain(0); // trigger immediately
    });
  }

  // Run first cycle immediately
  await runCycle();
```

### 3c. Verify

```bash
npm run build   # TypeScript compiles
npx vitest run tests/watchdog.test.ts tests/watchdog-wake.test.ts
```

### 3d. Commit

```bash
git add src/watchdog.ts src/index.ts
git commit -m "feat: wire watchdog anomaly -> early Brain wake with 30s debounce"
```

---

## Step 4: Add `imbalancePct` change to anomaly detection

Currently Watchdog only detects PRICE_SPIKE and OI_SPIKE. Order book imbalance flips (e.g., from +30% bid-heavy to -20% ask-heavy) are also significant microstructure anomalies.

### 4a. Write failing test

**File:** `tests/watchdog.test.ts`

```typescript
  it('emits anomaly event on order book imbalance flip > 40pp', async () => {
    mockGetLatest.mockResolvedValue({
      pair: 'BTCUSDT',
      mark_price: 70000,
      open_interest: 50000,
      funding_rate: 0.0001,
      imbalance_pct: 25,        // was bid-heavy
    });
    // New snapshot: ask-heavy (-20%), delta = 45pp
    mockMarketData.getQuickSnapshot.mockResolvedValue({
      pair: 'BTCUSDT',
      markPrice: '70000',
      openInterest: '50000',
      fundingRate: '0.0001',
      orderBookBidPct: 40,
      orderBookAskPct: 60,
      longShortRatio: 1.2,
      imbalancePct: -20,
    });

    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test-session',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
    });

    const events: any[] = [];
    wd.on('anomaly', (e) => events.push(e));

    await wd.tick();

    const imbEvent = events.find(e => e.type === 'IMBALANCE_FLIP');
    expect(imbEvent).toBeDefined();
    expect(imbEvent.detail).toContain('45');
  });
```

### 4b. Run and verify failure

```bash
npx vitest run tests/watchdog.test.ts
```

Fails because `'IMBALANCE_FLIP'` anomaly type does not exist yet.

### 4c. Implement

**File:** `src/watchdog.ts`

Update the `AnomalyEvent` type:
```typescript
export interface AnomalyEvent {
  pair: string;
  type: 'PRICE_SPIKE' | 'OI_SPIKE' | 'IMBALANCE_FLIP';
  detail: string;
  timestamp: number;
}
```

Add imbalance detection at the end of the anomaly block in `processPair()`, after the OI spike check:

```typescript
      // Order book imbalance flip > 40 percentage points
      if (prev.imbalance_pct !== undefined && prev.imbalance_pct !== null
          && current.imbalance_pct !== undefined && current.imbalance_pct !== null) {
        const imbDelta = Math.abs(current.imbalance_pct - Number(prev.imbalance_pct));
        if (imbDelta > 40) {
          const detail = `${imbDelta.toFixed(0)}pp shift (${Number(prev.imbalance_pct)} -> ${current.imbalance_pct})`;
          this.deps.onAnomaly?.(pair, 'IMBALANCE_FLIP', detail);
          this.emit('anomaly', { pair, type: 'IMBALANCE_FLIP', detail, timestamp: Date.now() } as AnomalyEvent);
        }
      }
```

### 4d. Run and verify pass

```bash
npx vitest run tests/watchdog.test.ts
```

### 4e. Commit

```bash
git add src/watchdog.ts tests/watchdog.test.ts
git commit -m "feat(watchdog): detect order book imbalance flips as anomalies"
```

---

## Summary

| Step | What | Files |
|------|-------|-------|
| 1 | Watchdog extends EventEmitter, emits structured anomaly events | `src/watchdog.ts`, `tests/watchdog.test.ts` |
| 2 | Test debounce logic for anomaly-triggered Brain wake | `tests/watchdog-wake.test.ts` |
| 3 | Wire anomaly listener in index.ts with clearTimeout + debounce | `src/index.ts` |
| 4 | Add IMBALANCE_FLIP anomaly detection | `src/watchdog.ts`, `tests/watchdog.test.ts` |

**Total new/changed files:** 4
**Total new tests:** 7
**Backward compatibility:** Full — existing `onAnomaly` callback still works alongside EventEmitter
