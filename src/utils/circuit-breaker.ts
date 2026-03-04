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
