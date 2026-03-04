import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

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
  start_balance?: number;
  last_order_result?: string;
}

export class SessionMemory {
  private get memoryDir() { return join(process.env.HOME || '.', '.indic-bot'); }
  private get memoryFile() { return join(this.memoryDir, 'memory.json'); }

  load(): MemoryState {
    try {
      const raw = readFileSync(this.memoryFile, 'utf-8');
      return JSON.parse(raw) as MemoryState;
    } catch {
      return { session_notes: '', recent_trades: [], last_updated: '' };
    }
  }

  save(state: MemoryState): void {
    mkdirSync(this.memoryDir, { recursive: true });
    writeFileSync(this.memoryFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  addTrade(trade: TradeRecord): void {
    const state = this.load();
    state.recent_trades = [trade, ...state.recent_trades].slice(0, 20);
    state.last_updated = new Date().toISOString();
    this.save(state);
  }

  getStartBalance(): number | undefined {
    return this.load().start_balance;
  }

  setStartBalance(balance: number): void {
    const state = this.load();
    if (state.start_balance === undefined) {
      state.start_balance = balance;
      state.last_updated = new Date().toISOString();
      this.save(state);
    }
  }

  setLastOrderResult(result: string): void {
    const state = this.load();
    state.last_order_result = result;
    state.last_updated = new Date().toISOString();
    this.save(state);
  }

  getLastOrderResult(): string | undefined {
    return this.load().last_order_result;
  }

  updateNotes(notes: string): void {
    const state = this.load();
    state.session_notes = notes;
    state.last_updated = new Date().toISOString();
    this.save(state);
  }
}
