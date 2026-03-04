import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { NewsCache, type NewsCacheState } from '../../src/news/news-cache.js';

const TEST_HOME = '/tmp/indic-bot-test-news';

beforeEach(() => {
  mkdirSync(join(TEST_HOME, '.indic-bot'), { recursive: true });
  vi.stubEnv('HOME', TEST_HOME);
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const makeState = (hoursAgo: number): NewsCacheState => ({
  items: [{ title: 'Test', date: '2026-03-04', coins: ['BTC'], sentiment: 1, source: 'test' }],
  fetchedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  analysis: {
    market_summary: 'BTC bullish',
    top_signals: [],
    overall_sentiment: 'bullish',
    macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
    risk_events: [],
  },
  analyzedAt: new Date().toISOString(),
});

describe('NewsCache', () => {
  it('returns null when no cache file exists', () => {
    const cache = new NewsCache();
    expect(cache.load()).toBeNull();
  });

  it('saves and loads state', () => {
    const cache = new NewsCache();
    const state = makeState(1);
    cache.save(state);
    const loaded = cache.load();
    expect(loaded?.analysis?.market_summary).toBe('BTC bullish');
    // items are now stored in SQLite; JSON always has items: []
    expect(loaded?.items).toHaveLength(0);
    expect(cache.dbCount()).toBe(1);
  });

  it('shouldRefresh returns true when no cache', () => {
    const cache = new NewsCache();
    expect(cache.shouldRefresh(12)).toBe(true);
  });

  it('shouldRefresh returns false when cache is fresh', () => {
    const cache = new NewsCache();
    cache.save(makeState(1)); // 1 hour ago
    expect(cache.shouldRefresh(12)).toBe(false);
  });

  it('shouldRefresh returns true when cache is stale', () => {
    const cache = new NewsCache();
    cache.save(makeState(13)); // 13 hours ago
    expect(cache.shouldRefresh(12)).toBe(true);
  });

  it('getAnalysis returns null when no cache', () => {
    const cache = new NewsCache();
    expect(cache.getAnalysis()).toBeNull();
  });

  it('getAnalysis returns analysis from saved state', () => {
    const cache = new NewsCache();
    cache.save(makeState(1));
    const analysis = cache.getAnalysis();
    expect(analysis?.overall_sentiment).toBe('bullish');
  });

  it('appendHistory creates history file', () => {
    const cache = new NewsCache();
    const state = makeState(0);
    cache.appendHistory(state);
    const historyPath = join(TEST_HOME, '.indic-bot', 'news-history.jsonl');
    expect(existsSync(historyPath)).toBe(true);
    const line = JSON.parse(readFileSync(historyPath, 'utf-8').trim());
    expect(line.itemCount).toBe(1);
    expect(line.analysis.market_summary).toBe('BTC bullish');
  });

  it('appendHistory appends without overwriting', () => {
    const cache = new NewsCache();
    cache.appendHistory(makeState(2));
    cache.appendHistory(makeState(1));
    const historyPath = join(TEST_HOME, '.indic-bot', 'news-history.jsonl');
    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
