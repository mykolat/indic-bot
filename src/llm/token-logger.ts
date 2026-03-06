import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { insertTokenUsage } from '../db/repository.js';

export interface TokenLogEntry {
  method: 'analyze' | 'call';
  label?: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  cycle?: number;
  estimated?: boolean;
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
        estimated: entry.estimated || false,
      }) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');

      // Dual-write to DB
      insertTokenUsage({
        model: entry.model,
        method: entry.method,
        label: entry.label,
        tokens_in: entry.tokensIn,
        tokens_out: entry.tokensOut,
        estimated: entry.estimated,
      }).catch(() => {});
    } catch {
      // Non-critical — never crash the bot over logging
    }
  }
}
