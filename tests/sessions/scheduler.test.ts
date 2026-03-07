import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TieredScheduler } from '../../src/sessions/scheduler.js';

describe('TieredScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs strategic on first call (never ran)', () => {
    const scheduler = new TieredScheduler();
    expect(scheduler.shouldRunStrategic()).toBe(true);
    expect(scheduler.shouldRunTactical()).toBe(true);
  });

  it('does not run strategic again before interval elapses', () => {
    const scheduler = new TieredScheduler({ strategicIntervalMs: 8 * 3600_000 });
    scheduler.markStrategicDone();
    expect(scheduler.shouldRunStrategic()).toBe(false);

    vi.advanceTimersByTime(4 * 3600_000); // 4h
    expect(scheduler.shouldRunStrategic()).toBe(false);

    vi.advanceTimersByTime(4 * 3600_000 + 1); // past 8h
    expect(scheduler.shouldRunStrategic()).toBe(true);
  });

  it('runs tactical after 1h interval', () => {
    const scheduler = new TieredScheduler({ tacticalIntervalMs: 3600_000 });
    scheduler.markTacticalDone();
    expect(scheduler.shouldRunTactical()).toBe(false);

    vi.advanceTimersByTime(3600_001);
    expect(scheduler.shouldRunTactical()).toBe(true);
  });

  it('escalateToTactical forces next tactical run', () => {
    const scheduler = new TieredScheduler();
    scheduler.markTacticalDone();
    expect(scheduler.shouldRunTactical()).toBe(false);

    scheduler.escalateToTactical();
    expect(scheduler.shouldRunTactical()).toBe(true);
  });

  it('escalateToStrategic forces next strategic run', () => {
    const scheduler = new TieredScheduler();
    scheduler.markStrategicDone();
    expect(scheduler.shouldRunStrategic()).toBe(false);

    scheduler.escalateToStrategic();
    expect(scheduler.shouldRunStrategic()).toBe(true);
  });

  it('uses custom intervals', () => {
    const scheduler = new TieredScheduler({
      strategicIntervalMs: 1000,
      tacticalIntervalMs: 500,
    });
    scheduler.markStrategicDone();
    scheduler.markTacticalDone();

    vi.advanceTimersByTime(600);
    expect(scheduler.shouldRunStrategic()).toBe(false);
    expect(scheduler.shouldRunTactical()).toBe(true);

    vi.advanceTimersByTime(500);
    expect(scheduler.shouldRunStrategic()).toBe(true);
  });
});
