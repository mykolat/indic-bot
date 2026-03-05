import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { rmSync } from 'fs';
import { MemoryKeeper } from '../../src/memory/memory-keeper.js';
import type { SoulStats, SoulRejection, SoulInvisibleExit, SoulInsight } from '../../src/memory/memory-keeper.js';

const TEST_DIR = join(process.cwd(), 'tmp-soul-test');

describe('MemoryKeeper', () => {
  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch { }
  });

  beforeEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch { }
  });

  it('creates memory.md from template on first init', () => {
    const sk = new MemoryKeeper(TEST_DIR);
    const content = sk.read();
    expect(content).toContain('# Dynamic Memory');
    expect(content).toContain("## What I've Learned");
    expect(content).toContain('## Performance Stats');
  });

  it('preserves existing memory.md on re-init', () => {
    const sk1 = new MemoryKeeper(TEST_DIR);
    sk1.writeNarrativeSections({ learned: 'I am learning.' });
    const contentBefore = sk1.read();

    const sk2 = new MemoryKeeper(TEST_DIR);
    const contentAfter = sk2.read();
    expect(contentAfter).toBe(contentBefore);
    expect(contentAfter).toContain('I am learning.');
  });

  it('updateStats replaces Performance Stats section', () => {
    const sk = new MemoryKeeper(TEST_DIR);
    const stats: SoulStats = {
      winRate: 62.5,
      avgWinPct: 1.80,
      avgLossPct: -0.95,
      profitFactor: 2.10,
      currentStreak: 3,
      sessionPnlPct: 4.25,
      bestPair: 'ETHUSDT',
      worstPair: 'SOLUSDT',
      totalTrades: 48,
    };
    sk.updateStats(stats);
    const content = sk.read();

    expect(content).toContain('**Win rate:** 62.5%');
    expect(content).toContain('**Profit factor:** 2.10');
    expect(content).toContain('3W');
    expect(content).toContain('**Best pair:** ETHUSDT');
    expect(content).toContain('**Total trades:** 48');

    // Other sections untouched
    expect(content).toContain("## What I've Learned");
    expect(content).toContain('_Nothing yet — waiting for first trades._');
  });

  it('addRejection prepends entry, keeps max 10', () => {
    const sk = new MemoryKeeper(TEST_DIR);

    for (let i = 0; i < 12; i++) {
      const rejection: SoulRejection = {
        pair: `PAIR${i}`,
        action: 'LONG',
        reason: `reason-${i}`,
        timestamp: `2026-03-04T10:${String(i).padStart(2, '0')}:00`,
      };
      sk.addRejection(rejection);
    }

    const content = sk.read();

    // Most recent (i=11) should be present
    expect(content).toContain('PAIR11 LONG: reason-11');
    // Oldest two (i=0, i=1) should be trimmed
    expect(content).not.toContain('PAIR0 LONG');
    expect(content).not.toContain('PAIR1 LONG');

    // Count list entries in rejections section
    const lines = content.split('\n').filter(l => l.startsWith('- [') && l.includes('LONG: reason-'));
    expect(lines).toHaveLength(10);
  });

  it('addInvisibleExit prepends entry with signed pnl', () => {
    const sk = new MemoryKeeper(TEST_DIR);

    const slExit: SoulInvisibleExit = {
      pair: 'BTCUSDT',
      side: 'LONG',
      type: 'SL',
      pnlPct: -2.1,
      timestamp: '2026-03-04T14:30:00',
    };

    const tpExit: SoulInvisibleExit = {
      pair: 'ETHUSDT',
      side: 'SHORT',
      type: 'TP',
      pnlPct: 3.5,
      timestamp: '2026-03-04T15:00:00',
    };

    sk.addInvisibleExit(slExit);
    sk.addInvisibleExit(tpExit);

    const content = sk.read();

    // TP was added second, so it should be first (prepended)
    expect(content).toContain('ETHUSDT SHORT: TP hit at +3.5%');
    expect(content).toContain('BTCUSDT LONG: SL hit at -2.1%');

    // Verify order: TP line should come before SL line
    const tpIdx = content.indexOf('ETHUSDT SHORT: TP hit');
    const slIdx = content.indexOf('BTCUSDT LONG: SL hit');
    expect(tpIdx).toBeLessThan(slIdx);
  });

  it('addExternalInsight keeps max 5, FIFO', () => {
    const sk = new MemoryKeeper(TEST_DIR);

    for (let i = 0; i < 7; i++) {
      const insight: SoulInsight = {
        source: `Source${i}`,
        text: `insight-text-${i}`,
        timestamp: `2026-03-04T10:${String(i).padStart(2, '0')}:00`,
      };
      sk.addExternalInsight(insight);
    }

    const content = sk.read();

    // Latest (i=6) should exist
    expect(content).toContain('**Source6:** insight-text-6');
    // Oldest two (i=0, i=1) should be trimmed
    expect(content).not.toContain('Source0');
    expect(content).not.toContain('Source1');

    // Count insight entries
    const lines = content.split('\n').filter(l => l.startsWith('- [') && l.includes('insight-text-'));
    expect(lines).toHaveLength(5);
  });

  it('writeNarrativeSections updates only specified sections', () => {
    const sk = new MemoryKeeper(TEST_DIR);
    const contentBefore = sk.read();

    // Capture original "learned" and "regime" content
    const learnedBefore = '_Nothing yet — waiting for first trades._';
    const regimeBefore = '_No regime assessment yet._';
    expect(contentBefore).toContain(learnedBefore);
    expect(contentBefore).toContain(regimeBefore);

    // Update only identity and failures
    sk.writeNarrativeSections({
      learned: 'I am a battle-tested trading agent.',
      failures: 'I tend to over-trade in choppy markets.',
    });

    const contentAfter = sk.read();

    // Updated sections should have new content
    expect(contentAfter).toContain('I am a battle-tested trading agent.');
    expect(contentAfter).toContain('I tend to over-trade in choppy markets.');

    // Untouched sections should preserve original content
    expect(contentAfter).toContain(regimeBefore);
  });

  it('backs up history dynamically', () => {
    const sk = new MemoryKeeper(TEST_DIR);
    sk.writeNarrativeSections({ learned: 'Version 1' });
    sk.backupHistory();

    // Check if the history directory was created and contains the backup
    const historyDir = join(TEST_DIR, 'docs', 'deepresult', 'memory_history');
    const { readdirSync, readFileSync } = require('fs');
    const files = readdirSync(historyDir);
    expect(files.length).toBe(1);

    const backupContent = readFileSync(join(historyDir, files[0]), 'utf-8');
    expect(backupContent).toContain('Version 1');
  });
});
