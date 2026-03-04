import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

// Override HOME so tests don't touch real ~/.indic-bot
const TEST_HOME = join(tmpdir(), 'indic-bot-test-' + Date.now());
process.env.HOME = TEST_HOME;

import { SessionMemory } from '../../src/memory/session.js';

describe('SessionMemory', () => {
  let mem: SessionMemory;

  beforeEach(() => {
    mem = new SessionMemory();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  it('returns empty state when no file exists', () => {
    const state = mem.load();
    expect(state.session_notes).toBe('');
    expect(state.recent_trades).toHaveLength(0);
  });

  it('saves and loads state', () => {
    mem.save({ session_notes: 'test notes', recent_trades: [], last_updated: new Date().toISOString() });
    const state = mem.load();
    expect(state.session_notes).toBe('test notes');
  });

  it('addTrade keeps max 20 trades', () => {
    for (let i = 0; i < 25; i++) {
      mem.addTrade({ pair: 'BTCUSDT', action: 'LONG', pnlUsd: i, pnlPct: i, closedAt: new Date().toISOString() });
    }
    expect(mem.load().recent_trades).toHaveLength(20);
  });

  it('updateNotes sets session_notes', () => {
    mem.updateNotes('new insight: BTC trending up');
    expect(mem.load().session_notes).toBe('new insight: BTC trending up');
  });
});
