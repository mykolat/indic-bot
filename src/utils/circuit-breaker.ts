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
