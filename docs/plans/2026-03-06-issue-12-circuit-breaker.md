# Issue #12: Circuit Breaker Has No Auto-Recovery — Bot Hangs Forever

**Priority:** HIGH — once the breaker opens, the bot stops trading permanently until manual restart.

## Problem

`CircuitBreaker` in `src/utils/circuit-breaker.ts` has only two states: **closed** (healthy) and **open** (blocking). Once 3 consecutive failures trip the breaker open, there is no mechanism to recover:

```typescript
// src/utils/circuit-breaker.ts:12-14
isOpen(): boolean {
  return this.failures >= this.threshold;
}
```

In `src/trading-loop.ts:130-134`, when `isOpen()` returns `true`, the cycle is skipped entirely — no API calls are made, so `recordSuccess()` is never called, and the breaker stays open forever:

```typescript
// src/trading-loop.ts:130-134
if (this.binanceCircuitBreaker.isOpen()) {
  console.log(`[Loop] Binance circuit breaker open ...`);
  logger.logError('CIRCUIT_BREAKER_OPEN', `Skipping cycle ...`);
  return;  // <-- exits immediately, no recovery path
}
```

**Real-world scenario:** Binance has a 1-2 minute maintenance window. The bot hits 3 failures in ~3 cycles (30 min), opens the breaker, and then never trades again. Requires SSH into GCP VM and `pm2 restart indic-bot`.

## Solution

Implement the standard **half-open** state from the Circuit Breaker pattern:

1. **Closed** — all requests flow through normally. Failures increment counter.
2. **Open** — all requests blocked. After `cooldownMs` elapses, transition to half-open.
3. **Half-Open** — allow exactly 1 probe request. If it succeeds → closed. If it fails → back to open (reset cooldown timer).

```
         success
  [CLOSED] ←──────── [HALF-OPEN]
     │                    ↑ cooldown elapsed
     │ 3 failures         │
     ↓                    │
  [OPEN] ─────────────────┘
     ↑         failure
     └──────── [HALF-OPEN]
```

Default cooldown: **60 seconds** (configurable). This means after 3 consecutive Binance failures, the bot waits 60s, tries one probe cycle, and either recovers or waits another 60s.

## Files Changed

| File | Change |
|------|--------|
| `src/utils/circuit-breaker.ts` | Add `State` enum, `openedAt` timestamp, `cooldownMs`, half-open logic |
| `tests/utils/circuit-breaker.test.ts` | New tests for half-open state, cooldown, probe success/failure |
| `src/trading-loop.ts` | Minor: update constructor call to pass cooldown (optional) |

## Implementation Tasks

### Task 1: Add half-open state transition tests (3 min)

**1a. Write failing tests**

Add to `tests/utils/circuit-breaker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/utils/circuit-breaker.js';

// ... keep existing tests ...

describe('CircuitBreaker — half-open recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions from open to half-open after cooldown elapses', () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    expect(cb.state).toBe('open');

    // Before cooldown
    vi.advanceTimersByTime(59_999);
    expect(cb.isOpen()).toBe(true);
    expect(cb.state).toBe('open');

    // After cooldown — should be half-open (not blocking)
    vi.advanceTimersByTime(1);
    expect(cb.isOpen()).toBe(false);  // allows probe
    expect(cb.state).toBe('half-open');
  });

  it('half-open → closed on recordSuccess()', () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(60_000);
    expect(cb.state).toBe('half-open');

    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.isOpen()).toBe(false);
    expect(cb.failureCount).toBe(0);
  });

  it('half-open → open on recordFailure() (resets cooldown)', () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(60_000);
    expect(cb.state).toBe('half-open');

    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.isOpen()).toBe(true);

    // Must wait another full cooldown
    vi.advanceTimersByTime(59_999);
    expect(cb.isOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cb.state).toBe('half-open');
  });

  it('uses default cooldown of 60s', () => {
    const cb = new CircuitBreaker(3); // no cooldownMs arg
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    vi.advanceTimersByTime(60_000);
    expect(cb.state).toBe('half-open');
  });

  it('recordSuccess in closed state keeps it closed', () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });

  it('partial failures then success resets counter (stays closed)', () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });

  it('multiple open→half-open→open cycles work correctly', () => {
    const cb = new CircuitBreaker(3, 10_000);

    // Trip breaker
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.state).toBe('open');

    // Cycle 1: half-open → fail → open
    vi.advanceTimersByTime(10_000);
    expect(cb.state).toBe('half-open');
    cb.recordFailure();
    expect(cb.state).toBe('open');

    // Cycle 2: half-open → fail → open
    vi.advanceTimersByTime(10_000);
    expect(cb.state).toBe('half-open');
    cb.recordFailure();
    expect(cb.state).toBe('open');

    // Cycle 3: half-open → success → closed
    vi.advanceTimersByTime(10_000);
    expect(cb.state).toBe('half-open');
    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.failureCount).toBe(0);
  });
});
```

**1b. Verify tests fail** — `npx vitest run tests/utils/circuit-breaker.test.ts`

Expected failures:
- `cb.state` property does not exist
- Constructor does not accept 2nd argument
- `isOpen()` returns `true` permanently after 3 failures (no half-open transition)

**1c. Commit** — `git commit -m "test(circuit-breaker): add half-open recovery tests (failing)"`

---

### Task 2: Implement half-open state in `CircuitBreaker` (5 min)

**2a. Implement**

Replace `src/utils/circuit-breaker.ts` entirely:

```typescript
/**
 * Circuit breaker with three states: closed, open, half-open.
 *
 * - CLOSED: requests flow normally. Consecutive failures increment counter.
 * - OPEN: all requests blocked. After cooldownMs, transitions to half-open.
 * - HALF-OPEN: allows exactly one probe request.
 *   - If probe succeeds → CLOSED (counter reset).
 *   - If probe fails → OPEN (cooldown restarts).
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number = 3,
    private readonly cooldownMs: number = 60_000,
  ) {}

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      // (Re)open the breaker — reset cooldown timer
      this.openedAt = Date.now();
    }
  }

  /**
   * Returns true when the breaker is fully open (blocking).
   * Returns false when closed OR half-open (probe allowed).
   */
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;

    // Breaker has tripped — check if cooldown has elapsed
    if (this.openedAt !== null && Date.now() - this.openedAt >= this.cooldownMs) {
      return false; // half-open — allow one probe
    }

    return true; // still in cooldown — block
  }

  get state(): CircuitState {
    if (this.failures < this.threshold) return 'closed';
    if (this.openedAt !== null && Date.now() - this.openedAt >= this.cooldownMs) return 'half-open';
    return 'open';
  }

  get failureCount(): number {
    return this.failures;
  }
}
```

Key design decisions:
- `isOpen()` returns `false` for half-open state (allows the probe request through)
- `recordFailure()` in half-open refreshes `openedAt` to restart the cooldown
- `recordSuccess()` fully resets both `failures` and `openedAt`
- No in-flight tracking needed: `TradingLoop` has single-threaded cycles so at most 1 probe runs at a time

**2b. Verify tests pass** — `npx vitest run tests/utils/circuit-breaker.test.ts`

All existing tests should still pass because:
- The 2-arg constructor is backward-compatible (cooldownMs defaults to 60_000)
- `recordSuccess()` still resets failures to 0
- `isOpen()` still returns `true` when `failures >= threshold` (within cooldown)

**2c. Commit** — `git commit -m "feat(circuit-breaker): add half-open state with timed recovery"`

---

### Task 3: Add logging for state transitions in TradingLoop (3 min)

**3a. Write failing test**

Add to `tests/trading-loop.test.ts` (or verify the existing circuit breaker test covers it). First, find the relevant existing test:

The test at `tests/trading-loop.test.ts` should already test circuit breaker behavior. We need to verify that after cooldown, the loop retries instead of skipping forever.

Add to `tests/trading-loop.test.ts`:

```typescript
it('retries after circuit breaker cooldown elapses (half-open probe)', async () => {
  vi.useFakeTimers();
  try {
    // Trip the breaker: make marketData.getSnapshot fail for all pairs
    deps.marketData.getSnapshot = vi.fn().mockRejectedValue(new Error('timeout'));

    // Run 3 cycles to trip the breaker
    await loop.runOnce(); // all fail → recordFailure
    await loop.runOnce(); // all fail → recordFailure
    await loop.runOnce(); // all fail → recordFailure

    // 4th cycle — breaker is open, should skip (no getSnapshot call)
    const callsBefore = (deps.marketData.getSnapshot as any).mock.calls.length;
    await loop.runOnce();
    expect((deps.marketData.getSnapshot as any).mock.calls.length).toBe(callsBefore);

    // Advance past cooldown
    vi.advanceTimersByTime(60_000);

    // Fix the API
    deps.marketData.getSnapshot = vi.fn().mockResolvedValue(makeSnapshot('BTCUSDT'));

    // 5th cycle — half-open, should allow probe
    await loop.runOnce();
    expect(deps.marketData.getSnapshot).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
```

Note: This test depends on the existing test setup in `tests/trading-loop.test.ts`. The mock helpers (`deps`, `loop`, `makeSnapshot`) should already exist. Adapt variable names to match the existing test file.

**3b. Verify test fails** — `npx vitest run tests/trading-loop.test.ts`

Expected: The 5th `runOnce()` call still skips because old `CircuitBreaker` has no half-open.

**3c. Implement**

Update `src/trading-loop.ts` at line 130-134 to add logging for the half-open state:

```typescript
// Circuit breaker: skip cycle if Binance has been failing consecutively
if (this.binanceCircuitBreaker.isOpen()) {
  const state = this.binanceCircuitBreaker.state;
  console.log(`[Loop] Binance circuit breaker ${state} (${this.binanceCircuitBreaker.failureCount} consecutive failures) — skipping cycle`);
  logger.logError('CIRCUIT_BREAKER_OPEN', `Skipping cycle — ${this.binanceCircuitBreaker.failureCount} consecutive Binance failures (${state})`);
  return;
}

// Log when probing after half-open recovery
if (this.binanceCircuitBreaker.state === 'half-open') {
  console.log(`[Loop] Circuit breaker half-open — probing Binance with this cycle`);
}
```

No constructor change needed — `CircuitBreaker(3)` defaults to 60s cooldown.

**3d. Verify test passes** — `npx vitest run tests/trading-loop.test.ts`

**3e. Commit** — `git commit -m "feat(trading-loop): log circuit breaker half-open probes"`

---

### Task 4: Run full test suite and verify backward compatibility (2 min)

**4a.** Run all tests:
```bash
npx vitest run
```

**4b.** Verify these specific test files pass:
- `tests/utils/circuit-breaker.test.ts` — all 6 existing + 7 new tests
- `tests/binance/orders.test.ts` — no changes needed (doesn't use CircuitBreaker)
- `tests/trading-loop.test.ts` — existing tests + new half-open test

**4c.** Verify no other file imports `CircuitBreaker` that would be affected:
```bash
grep -r "CircuitBreaker" src/ tests/
```
Only `src/trading-loop.ts` and `tests/utils/circuit-breaker.test.ts` import it.

**4d. Commit** — `git commit -m "test: verify full suite passes with circuit breaker half-open"`

---

## Verification Checklist

- [ ] `CircuitBreaker` has 3 states: `closed`, `open`, `half-open`
- [ ] `state` getter returns the correct state at all times
- [ ] After 3 failures, breaker enters `open` state
- [ ] After `cooldownMs` in `open` state, transitions to `half-open`
- [ ] `isOpen()` returns `false` in `half-open` state (allows probe)
- [ ] `recordSuccess()` in `half-open` → `closed` (full recovery)
- [ ] `recordFailure()` in `half-open` → `open` (restarts cooldown)
- [ ] Default cooldown is 60 seconds
- [ ] Constructor backward-compatible: `new CircuitBreaker(3)` still works
- [ ] All existing tests pass without modification
- [ ] `TradingLoop` logs half-open probe attempts
- [ ] Multiple open→half-open→open→half-open→closed cycles work

## Risk Assessment

- **Very low risk**: The `CircuitBreaker` class is used in exactly one place (`TradingLoop`). The API is additive — `isOpen()` and `recordSuccess()`/`recordFailure()` work identically for the closed→open transition.
- **Behavioral change**: The only difference is that after 60s of being open, the breaker now allows a probe cycle. Previously it blocked forever. This is strictly an improvement.
- **No config change needed**: 60s default is hardcoded in the constructor. If we ever want to tune it, we can pass it from `config.yaml` later.
- **Thread safety**: Not a concern — `TradingLoop.runOnce()` is single-threaded (async but sequential). Only one cycle runs at a time, so the half-open state will never have concurrent probes.
