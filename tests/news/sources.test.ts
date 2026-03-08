import { describe, it, expect } from 'vitest';
import { NEWS_SOURCES, getSourceByName } from '../../src/news/sources.js';

describe('NEWS_SOURCES', () => {
  it('has at least 15 sources', () => {
    expect(NEWS_SOURCES.length).toBeGreaterThanOrEqual(15);
  });

  it('all sources have required fields', () => {
    for (const s of NEWS_SOURCES) {
      expect(s.name).toBeTruthy();
      expect(s.url).toMatch(/^https?:\/\//);
      expect(['newsroom', 'research', 'venue', 'protocol']).toContain(s.sourceType);
      expect(typeof s.priority).toBe('number');
    }
  });

  it('getSourceByName finds CoinDesk', () => {
    const s = getSourceByName('CoinDesk');
    expect(s?.sourceType).toBe('newsroom');
  });

  it('has at least one of each sourceType', () => {
    const types = new Set(NEWS_SOURCES.map(s => s.sourceType));
    expect(types).toContain('newsroom');
    expect(types).toContain('venue');
    expect(types).toContain('protocol');
    expect(types).toContain('research');
  });
});
