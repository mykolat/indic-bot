import { describe, it, expect } from 'vitest';
import type { NewsEvent } from '../../src/news/types.js';

describe('NewsEvent type', () => {
  it('has required fields', () => {
    const e: NewsEvent = {
      title: 'SEC delays ETF',
      date: '2026-03-08T12:00:00Z',
      url: 'https://coindesk.com/sec-etf',
      source: 'CoinDesk',
      sourceType: 'newsroom',
      coins: [],
      sentiment: 0,
      tickers: ['ETH'],
      topics: ['ETF', 'Regulation'],
      priority: 0.86,
    };
    expect(e.sourceType).toBe('newsroom');
    expect(e.tickers).toEqual(['ETH']);
    expect(e.topics).toContain('ETF');
    expect(e.priority).toBeGreaterThan(0);
  });

  it('allows optional excerpt', () => {
    const e: NewsEvent = {
      title: 'BTC ATH', date: '', url: '', source: '', sourceType: 'newsroom',
      coins: [], sentiment: 0, tickers: [], topics: [], priority: 0,
      excerpt: 'Bitcoin set a new all-time high...',
    };
    expect(e.excerpt).toBeDefined();
  });
});
