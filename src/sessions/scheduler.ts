export class TieredScheduler {
  private lastStrategic = 0;
  private lastTactical = 0;
  private strategicIntervalMs: number;
  private tacticalIntervalMs: number;

  constructor(opts?: { strategicIntervalMs?: number; tacticalIntervalMs?: number }) {
    this.strategicIntervalMs = opts?.strategicIntervalMs ?? 8 * 3600_000; // 3x/day
    this.tacticalIntervalMs = opts?.tacticalIntervalMs ?? 3600_000;       // 1x/hour
  }

  shouldRunStrategic(): boolean {
    return Date.now() - this.lastStrategic >= this.strategicIntervalMs;
  }

  shouldRunTactical(): boolean {
    return Date.now() - this.lastTactical >= this.tacticalIntervalMs;
  }

  markStrategicDone(): void { this.lastStrategic = Date.now(); }
  markTacticalDone(): void { this.lastTactical = Date.now(); }

  escalateToTactical(): void { this.lastTactical = 0; }
  escalateToStrategic(): void { this.lastStrategic = 0; }
}
