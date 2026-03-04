import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TradeStory {
  pair: string;
  direction: 'LONG' | 'SHORT';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  regimeAtEntry: string;
  regimeAtExit: string;
  story: string;
  lesson: string;
}

export class TradeStoryLogger {
  constructor(private logFile: string) {}

  log(story: TradeStory): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        pair: story.pair, direction: story.direction,
        entry_time: story.entryTime, exit_time: story.exitTime,
        entry_price: story.entryPrice, exit_price: story.exitPrice,
        pnl_pct: story.pnlPct,
        regime_at_entry: story.regimeAtEntry, regime_at_exit: story.regimeAtExit,
        story: story.story, lesson: story.lesson,
      }) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');
    } catch { /* Non-critical */ }
  }

  getRecent(count: number): TradeStory[] {
    try {
      if (!existsSync(this.logFile)) return [];
      const lines = readFileSync(this.logFile, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-count).map(line => {
        const p = JSON.parse(line);
        return {
          pair: p.pair, direction: p.direction,
          entryTime: p.entry_time, exitTime: p.exit_time,
          entryPrice: p.entry_price, exitPrice: p.exit_price,
          pnlPct: p.pnl_pct,
          regimeAtEntry: p.regime_at_entry, regimeAtExit: p.regime_at_exit,
          story: p.story, lesson: p.lesson,
        };
      });
    } catch { return []; }
  }
}
