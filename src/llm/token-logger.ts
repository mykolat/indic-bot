import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface TokenLogEntry {
  method: 'analyze' | 'call';
  label?: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  cycle?: number;
}

export class TokenLogger {
  constructor(private logFile: string) {}

  log(entry: TokenLogEntry): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        method: entry.method,
        label: entry.label,
        tokens_in: entry.tokensIn,
        tokens_out: entry.tokensOut,
        model: entry.model,
        cycle: entry.cycle,
      }) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');
    } catch {
      // Non-critical — never crash the bot over logging
    }
  }
}
