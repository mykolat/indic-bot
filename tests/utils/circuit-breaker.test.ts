import { describe, it, expect } from 'vitest';
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
