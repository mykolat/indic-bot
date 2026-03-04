interface SourceStats {
  totalAttempts: number;
  successCount: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

interface GrokCostInfo {
  totalTokens: number;
  estimatedCostUsd: number;
  callCount: number;
}

// Grok-3 pricing: approximate blended ~$5/M tokens
const GROK_COST_PER_TOKEN = 5 / 1_000_000;

export class SourceHealthMonitor {
  private sources = new Map<string, SourceStats>();
  private grokTokens = 0;
  private grokCalls = 0;

  recordSuccess(source: string): void {
    const s = this.getOrCreate(source);
    s.totalAttempts++;
    s.successCount++;
    s.lastSuccessAt = new Date().toISOString();
  }

  recordFailure(source: string, error: string): void {
    const s = this.getOrCreate(source);
    s.totalAttempts++;
    s.lastError = error;
    s.lastFailureAt = new Date().toISOString();
  }

  recordGrokUsage(tokensUsed: number): void {
    this.grokTokens += tokensUsed;
    this.grokCalls++;
  }

  getHealth(source: string): SourceStats {
    return this.sources.get(source) ?? { totalAttempts: 0, successCount: 0 };
  }

  getGrokCost(): GrokCostInfo {
    return {
      totalTokens: this.grokTokens,
      estimatedCostUsd: this.grokTokens * GROK_COST_PER_TOKEN,
      callCount: this.grokCalls,
    };
  }

  getSummary(): string {
    const lines: string[] = [];
    for (const [name, stats] of this.sources) {
      const rate = stats.totalAttempts > 0
        ? Math.round((stats.successCount / stats.totalAttempts) * 100)
        : 0;
      const err = stats.lastError ? ` (last error: ${stats.lastError})` : '';
      lines.push(`${name}: ${rate}% success (${stats.successCount}/${stats.totalAttempts})${err}`);
    }
    const grok = this.getGrokCost();
    if (grok.callCount > 0) {
      lines.push(`Grok: ${grok.callCount} calls, ${grok.totalTokens} tokens, ~$${grok.estimatedCostUsd.toFixed(4)}`);
    }
    return lines.join('\n');
  }

  private getOrCreate(source: string): SourceStats {
    if (!this.sources.has(source)) {
      this.sources.set(source, { totalAttempts: 0, successCount: 0 });
    }
    return this.sources.get(source)!;
  }
}
