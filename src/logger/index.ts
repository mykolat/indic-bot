import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export class Logger {
  private dir: string;

  constructor(logDir: string = 'logs') {
    this.dir = logDir;
    mkdirSync(this.dir, { recursive: true });
  }

  logDecision(entry: Record<string, unknown>): void {
    this.append('decisions.jsonl', entry);
    const preview = JSON.stringify(entry).slice(0, 120);
    console.log(`[DECISION] ${preview}`);
  }

  logTrade(entry: Record<string, unknown>): void {
    this.append('trades.jsonl', entry);
    const preview = JSON.stringify(entry).slice(0, 120);
    console.log(`[TRADE] ${preview}`);
  }

  logError(code: string, message: string, details?: unknown): void {
    this.append('errors.jsonl', { code, message, details });
    console.error(`[ERROR] ${code}: ${message}`);
  }

  private append(file: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() });
    appendFileSync(join(this.dir, file), line + '\n', 'utf-8');
  }
}
