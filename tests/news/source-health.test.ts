import { describe, it, expect, beforeEach } from 'vitest';
import { SourceHealthMonitor } from '../../src/news/source-health.js';

describe('SourceHealthMonitor', () => {
  let monitor: SourceHealthMonitor;

  beforeEach(() => {
    monitor = new SourceHealthMonitor();
  });

  it('records success and failure for sources', () => {
    monitor.recordSuccess('CoinDesk');
    monitor.recordSuccess('CoinDesk');
    monitor.recordFailure('CoinDesk', 'timeout');

    const health = monitor.getHealth('CoinDesk');
    expect(health.totalAttempts).toBe(3);
    expect(health.successCount).toBe(2);
    expect(health.lastError).toBe('timeout');
  });

  it('tracks Grok API cost', () => {
    monitor.recordGrokUsage(300);
    monitor.recordGrokUsage(500);

    const cost = monitor.getGrokCost();
    expect(cost.totalTokens).toBe(800);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.callCount).toBe(2);
  });

  it('returns summary of all sources', () => {
    monitor.recordSuccess('CoinDesk');
    monitor.recordFailure('Decrypt', 'HTTP 403');
    monitor.recordGrokUsage(100);

    const summary = monitor.getSummary();
    expect(summary).toContain('CoinDesk');
    expect(summary).toContain('Decrypt');
    expect(summary).toContain('Grok');
  });

  it('returns healthy status for unknown source', () => {
    const health = monitor.getHealth('Unknown');
    expect(health.totalAttempts).toBe(0);
    expect(health.successCount).toBe(0);
  });
});
