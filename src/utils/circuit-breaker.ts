/**
 * Tracks consecutive failures for an external dependency (e.g. Binance API).
 * When the failure count reaches the threshold the breaker is "open" and callers
 * should skip the operation rather than continuing to hammer a failing service.
 * A single success resets the counter to zero (fully closed).
 */
export class CircuitBreaker {
  private failures = 0;

  constructor(private readonly threshold: number = 3) {}

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
  }

  isOpen(): boolean {
    return this.failures >= this.threshold;
  }

  get failureCount(): number {
    return this.failures;
  }
}
