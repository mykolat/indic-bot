import { describe, it, expect } from 'vitest';
import { getMarketSession, getSessionMetadata, formatSessionPromptBlock, type MarketSession } from '../../src/market/session.js';

describe('getMarketSession', () => {
  const cases: Array<[number, MarketSession]> = [
    [0, 'asia_dead_zone'],
    [3, 'asia_dead_zone'],
    [5, 'asia_dead_zone'],
    [6, 'london_open'],
    [9, 'london_open'],
    [10, 'london_continuation'],
    [12, 'london_continuation'],
    [13, 'london_ny_overlap'],
    [16, 'london_ny_overlap'],
    [17, 'ny_session'],
    [20, 'ny_session'],
    [21, 'ny_close_evening'],
    [23, 'ny_close_evening'],
  ];

  it.each(cases)('UTC hour %i → %s', (hour, expected) => {
    const date = new Date(`2026-03-07T${String(hour).padStart(2, '0')}:30:00Z`);
    expect(getMarketSession(date)).toBe(expected);
  });
});

describe('getSessionMetadata', () => {
  it('returns metadata for every session', () => {
    const sessions: MarketSession[] = [
      'asia_dead_zone', 'london_open', 'london_continuation',
      'london_ny_overlap', 'ny_session', 'ny_close_evening',
    ];
    for (const s of sessions) {
      const meta = getSessionMetadata(s);
      expect(meta.name).toBeTruthy();
      expect(meta.utcRange).toBeTruthy();
      expect(meta.typicalTendencies.length).toBeGreaterThan(0);
      expect(meta.confirmationSignals.length).toBeGreaterThan(0);
      expect(meta.rejectionSignals.length).toBeGreaterThan(0);
    }
  });
});

describe('formatSessionPromptBlock', () => {
  it('includes session name and neutral language', () => {
    const block = formatSessionPromptBlock(new Date('2026-03-07T03:00:00Z'));
    expect(block).toContain('Asia Session');
    expect(block).toContain('weak prior');
    expect(block).toContain('Confirm with');
    expect(block).toContain('Reject if');
    expect(block).not.toContain('dead zone');
    expect(block).not.toContain('most reliable');
    expect(block).not.toContain('full leverage');
  });

  it('London/NY overlap block references high participation', () => {
    const block = formatSessionPromptBlock(new Date('2026-03-07T14:00:00Z'));
    expect(block).toContain('London / NY Overlap');
    expect(block).toContain('weak prior');
  });

  it('every session block requires explicit assessment', () => {
    const hours = [1, 7, 11, 14, 18, 22];
    for (const h of hours) {
      const block = formatSessionPromptBlock(new Date(`2026-03-07T${String(h).padStart(2, '0')}:00:00Z`));
      expect(block).toContain('confirm, contradict, or make this session context irrelevant');
    }
  });
});
