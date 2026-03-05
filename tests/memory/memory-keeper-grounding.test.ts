import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SoulKeeper } from '../../src/memory/soul-keeper.js';
import { mkdirSync, rmSync, readFileSync } from 'fs';

const TEST_HOME = '/tmp/indic-soul-grounding-test';

describe('SoulKeeper — Verified Intelligence', () => {
  let keeper: SoulKeeper;

  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    keeper = new SoulKeeper(TEST_HOME);
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('writes verified intelligence entries', () => {
    keeper.writeVerifiedIntel([
      {
        claim: 'SEC approves spot BTC ETF',
        verified: true,
        confidence: 0.95,
        summary: 'Confirmed by @SECGov',
        timestamp: '2026-03-05T12:00:00Z',
      },
    ]);

    const content = readFileSync(`${TEST_HOME}/soul.md`, 'utf-8');
    expect(content).toContain('## Verified Intelligence');
    expect(content).toContain('SEC approves spot BTC ETF');
    expect(content).toContain('VERIFIED');
    expect(content).toContain('95%');
  });

  it('keeps only last 5 entries', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      claim: `Claim ${i}`,
      verified: true,
      confidence: 0.8,
      summary: `Summary ${i}`,
      timestamp: `2026-03-05T${String(i).padStart(2, '0')}:00:00Z`,
    }));
    keeper.writeVerifiedIntel(entries);

    const content = readFileSync(`${TEST_HOME}/soul.md`, 'utf-8');
    expect(content).not.toContain('Claim 0');
    expect(content).not.toContain('Claim 1');
    expect(content).toContain('Claim 6');
  });

  it('formats DEBUNKED and UNCONFIRMED statuses', () => {
    keeper.writeVerifiedIntel([
      { claim: 'Fake news', verified: false, confidence: 0.1, summary: 'No sources', timestamp: '2026-03-05T12:00:00Z' },
      { claim: 'Unknown', verified: null, confidence: undefined, summary: undefined, timestamp: '2026-03-05T12:00:00Z' },
    ]);

    const content = readFileSync(`${TEST_HOME}/soul.md`, 'utf-8');
    expect(content).toContain('DEBUNKED');
    expect(content).toContain('UNCONFIRMED');
    expect(content).toContain('no details');
  });
});
