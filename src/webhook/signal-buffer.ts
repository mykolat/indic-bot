export interface TradingViewSignal {
  signal: 'BUY' | 'SELL';
  pair: string;
  indicator: string;
  value: number;
  timeframe: string;
}

interface TimestampedSignal {
  data: TradingViewSignal;
  receivedAt: number;
}

interface SignalBufferOptions {
  maxSize: number;
  ttlMs: number;
}

export class SignalBuffer {
  private signals: TimestampedSignal[] = [];
  private maxSize: number;
  private ttlMs: number;

  constructor(opts: SignalBufferOptions) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  add(signal: TradingViewSignal): void {
    this.signals.push({ data: signal, receivedAt: Date.now() });
    if (this.signals.length > this.maxSize) {
      this.signals = this.signals.slice(-this.maxSize);
    }
  }

  getRecent(): TradingViewSignal[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.signals
      .filter((s) => s.receivedAt > cutoff)
      .map((s) => s.data);
  }

  drain(): TradingViewSignal[] {
    const result = this.getRecent();
    this.signals = [];
    return result;
  }

  clear(): void {
    this.signals = [];
  }
}
