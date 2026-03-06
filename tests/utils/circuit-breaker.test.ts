import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker(3);
    expect(cb.isOpen()).toBe(false);
  });

  it('opens after N consecutive failures', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('resets to closed on recordSuccess()', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    cb.recordSuccess();
    expect(cb.isOpen()).toBe(false);
  });

  it('exposes failureCount', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure(); cb.recordFailure();
    expect(cb.failureCount).toBe(2);
  });

  it('uses default threshold of 3', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('resets partial failure count on recordSuccess()', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();   // 2 failures — not yet open
    cb.recordSuccess();   // should zero the counter
    cb.recordFailure();   // one new failure
    expect(cb.failureCount).toBe(1);
    expect(cb.isOpen()).toBe(false);
  });
});

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
