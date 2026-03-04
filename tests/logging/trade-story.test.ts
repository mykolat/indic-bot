import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeStoryLogger, type TradeStory } from '../../src/logging/trade-story.js';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';

const TEST_FILE = '/tmp/test-trade-stories.jsonl';

describe('TradeStoryLogger', () => {
  let logger: TradeStoryLogger;

  beforeEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    logger = new TradeStoryLogger(TEST_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  it('logs a trade story as JSONL', () => {
    const story: TradeStory = {
      pair: 'BTCUSDT',
      direction: 'LONG',
      entryTime: '2026-03-05T10:00:00Z',
      exitTime: '2026-03-05T14:00:00Z',
      entryPrice: 72000,
      exitPrice: 73500,
      pnlPct: 2.1,
      regimeAtEntry: 'bull_trend',
      regimeAtExit: 'range',
      story: 'Entered on pullback, held through regime change.',
      lesson: 'Patience paid off.',
    };
    logger.log(story);
    const content = readFileSync(TEST_FILE, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.pair).toBe('BTCUSDT');
    expect(parsed.pnl_pct).toBe(2.1);
  });

  it('getRecent returns last N stories', () => {
    for (let i = 0; i < 10; i++) {
      logger.log({
        pair: 'BTCUSDT', direction: 'LONG',
        entryTime: `2026-03-05T0${i}:00:00Z`, exitTime: `2026-03-05T0${i + 1}:00:00Z`,
        entryPrice: 70000 + i * 100, exitPrice: 70100 + i * 100,
        pnlPct: 1, regimeAtEntry: 'bull_trend', regimeAtExit: 'bull_trend',
        story: `Trade ${i}`, lesson: `Lesson ${i}`,
      });
    }
    const recent = logger.getRecent(5);
    expect(recent.length).toBe(5);
    expect(recent[0].story).toBe('Trade 5');
    expect(recent[4].story).toBe('Trade 9');
  });

  it('getRecent returns empty array for missing file', () => {
    const fresh = new TradeStoryLogger('/tmp/nonexistent-stories.jsonl');
    expect(fresh.getRecent(5)).toEqual([]);
  });

  it('does not throw on write errors', () => {
    const bad = new TradeStoryLogger('/nonexistent/path/stories.jsonl');
    expect(() => bad.log({
      pair: 'X', direction: 'LONG', entryTime: '', exitTime: '',
      entryPrice: 0, exitPrice: 0, pnlPct: 0,
      regimeAtEntry: '', regimeAtExit: '', story: '', lesson: '',
    })).not.toThrow();
  });
});
