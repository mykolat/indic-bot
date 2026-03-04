import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NewsDB } from '../../src/news/news-db.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DIR = '/tmp/indic-test-newsdb';
const TEST_DB = join(TEST_DIR, 'news.db');

describe('NewsDB', () => {
  let db: NewsDB;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new NewsDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('inserts news items and retrieves them', () => {
    db.insert([
      { title: 'BTC hits $73K', date: new Date().toISOString(), coins: ['BTC'], sentiment: 1, source: 'coindesk' },
    ]);
    const recent = db.getRecent(48);
    expect(recent).toHaveLength(1);
    expect(recent[0].title).toBe('BTC hits $73K');
    expect(recent[0].age_hours).toBeGreaterThanOrEqual(0);
    expect(recent[0].age_hours).toBeLessThan(1);
  });

  it('deduplicates on title+date', () => {
    const item = { title: 'BTC hits $73K', date: '2026-03-04T10:00:00Z', coins: ['BTC'], sentiment: 1, source: 'coindesk' };
    db.insert([item]);
    db.insert([item]);
    expect(db.count()).toBe(1);
  });

  it('getRecent excludes items older than hours param', () => {
    const old = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    db.insert([{ title: 'Old news', date: old, coins: [], sentiment: 0, source: 'x' }]);
    expect(db.getRecent(48)).toHaveLength(0);
  });

  it('count returns total rows', () => {
    db.insert([
      { title: 'A', date: new Date().toISOString(), coins: [], sentiment: 0, source: 'x' },
      { title: 'B', date: new Date().toISOString(), coins: [], sentiment: 0, source: 'x' },
    ]);
    expect(db.count()).toBe(2);
  });
});
