import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = join(process.env.HOME || '.', '.indic-bot');
const MEMORY_FILE = join(MEMORY_DIR, 'memory.json');

export interface TradeRecord {
  pair: string;
  action: string;
  pnlUsd: number;
  pnlPct: number;
  closedAt: string;
}

export interface MemoryState {
  session_notes: string;
  recent_trades: TradeRecord[];
  last_updated: string;
}

export class SessionMemory {
  load(): MemoryState {
    try {
      const raw = readFileSync(MEMORY_FILE, 'utf-8');
      return JSON.parse(raw) as MemoryState;
    } catch {
      return { session_notes: '', recent_trades: [], last_updated: '' };
    }
  }

  save(state: MemoryState): void {
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }

  addTrade(trade: TradeRecord): void {
    const state = this.load();
    state.recent_trades = [trade, ...state.recent_trades].slice(0, 20);
    state.last_updated = new Date().toISOString();
    this.save(state);
  }

  updateNotes(notes: string): void {
    const state = this.load();
    state.session_notes = notes;
    state.last_updated = new Date().toISOString();
    this.save(state);
  }
}
