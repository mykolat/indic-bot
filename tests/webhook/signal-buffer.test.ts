import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SignalBuffer, TradingViewSignal } from '../../src/webhook/signal-buffer.js';

describe('SignalBuffer', () => {
  let buffer: SignalBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new SignalBuffer({ maxSize: 5, ttlMs: 30 * 60 * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds and retrieves signals', () => {
    const signal: TradingViewSignal = {
      signal: 'BUY',
      pair: 'BTCUSDT',
      indicator: 'RSI',
      value: 72,
      timeframe: '1h',
    };
    buffer.add(signal);

    const signals = buffer.getRecent();
    expect(signals).toHaveLength(1);
    expect(signals[0].pair).toBe('BTCUSDT');
  });

  it('enforces max size (circular buffer)', () => {
    for (let i = 0; i < 7; i++) {
      buffer.add({ signal: 'BUY', pair: `PAIR${i}`, indicator: 'RSI', value: i, timeframe: '1h' });
    }
    const signals = buffer.getRecent();
    expect(signals).toHaveLength(5);
    expect(signals[0].pair).toBe('PAIR2');
  });

  it('expires signals after TTL', () => {
    buffer.add({ signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 70, timeframe: '1h' });
    vi.advanceTimersByTime(31 * 60 * 1000);
    const signals = buffer.getRecent();
    expect(signals).toHaveLength(0);
  });

  it('clears all signals', () => {
    buffer.add({ signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 70, timeframe: '1h' });
    buffer.clear();
    expect(buffer.getRecent()).toHaveLength(0);
  });

  it('drains returns signals and clears buffer', () => {
    buffer.add({ signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 70, timeframe: '1h' });
    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    expect(buffer.getRecent()).toHaveLength(0);
  });
});
