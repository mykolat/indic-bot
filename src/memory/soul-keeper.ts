import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// ── Interfaces ──────────────────────────────────────────────────────────

export interface SoulStats {
  winRate: number;         // 0-100
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  currentStreak: number;   // positive = wins, negative = losses
  sessionPnlPct: number;
  bestPair: string;
  worstPair: string;
  totalTrades: number;
}

export interface SoulRejection {
  pair: string;
  action: string;
  reason: string;
  timestamp: string;
}

export interface SoulInvisibleExit {
  pair: string;
  side: string;
  type: 'SL' | 'TP' | 'AUTO_CLOSE';
  pnlPct: number;
  timestamp: string;
}

export interface SoulInsight {
  source: string;
  text: string;
  timestamp: string;
}

// ── Section markers ─────────────────────────────────────────────────────

export const SECTION_MARKERS: Record<string, string> = {
  identity:       '## Identity',
  learned:        '## What I\'ve Learned',
  failures:       '## My Failure Patterns',
  regime:         '## Current Regime View',
  insights:       '## External Insights',
  stats:          '## Performance Stats',
  rejections:     '## Recent Rejections',
  invisibleExits: '## Invisible Exits',
};

// ── Default template ────────────────────────────────────────────────────

export const TEMPLATE = `# Trading Soul

## Identity

I am a crypto futures trading agent. I learn from every trade.

## What I've Learned

_Nothing yet — waiting for first trades._

## My Failure Patterns

_No patterns detected yet._

## Current Regime View

_No regime assessment yet._

## External Insights

_No external insights yet._

## Performance Stats

_No stats yet._

## Recent Rejections

_No rejections yet._

## Invisible Exits

_No invisible exits yet._
`;

// ── SoulKeeper ──────────────────────────────────────────────────────────

export class SoulKeeper {
  private readonly soulPath: string;

  constructor(soulDir: string) {
    this.soulPath = join(soulDir, 'soul.md');
    if (!existsSync(this.soulPath)) {
      mkdirSync(dirname(this.soulPath), { recursive: true });
      writeFileSync(this.soulPath, TEMPLATE, 'utf-8');
    }
  }

  /** Return full soul.md content. */
  read(): string {
    return readFileSync(this.soulPath, 'utf-8');
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Replace everything between `## Header` and the next `## ` (or EOF)
   * with `newContent`. The header line itself is preserved.
   */
  private replaceSection(sectionKey: string, newContent: string): void {
    const marker = SECTION_MARKERS[sectionKey];
    if (!marker) throw new Error(`Unknown section key: ${sectionKey}`);

    const content = this.read();
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) throw new Error(`Section "${marker}" not found in soul.md`);

    // Start of body = after the marker line
    const bodyStart = content.indexOf('\n', markerIdx);
    if (bodyStart === -1) {
      // Marker is the very last line
      writeFileSync(this.soulPath, content + '\n\n' + newContent + '\n', 'utf-8');
      return;
    }

    // Find the next `## ` heading (if any)
    const nextHeadingMatch = content.slice(bodyStart).match(/\n## /);
    const bodyEnd = nextHeadingMatch
      ? bodyStart + nextHeadingMatch.index!
      : content.length;

    const before = content.slice(0, bodyStart);
    const after  = content.slice(bodyEnd);

    writeFileSync(this.soulPath, before + '\n\n' + newContent + '\n' + after, 'utf-8');
  }

  /**
   * Parse existing list entries from a section (lines starting with `- `).
   */
  private readListEntries(sectionKey: string): string[] {
    const marker = SECTION_MARKERS[sectionKey];
    if (!marker) return [];

    const content = this.read();
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) return [];

    const bodyStart = content.indexOf('\n', markerIdx);
    if (bodyStart === -1) return [];

    const nextHeadingMatch = content.slice(bodyStart).match(/\n## /);
    const bodyEnd = nextHeadingMatch
      ? bodyStart + nextHeadingMatch.index!
      : content.length;

    const body = content.slice(bodyStart, bodyEnd);
    return body
      .split('\n')
      .filter(line => line.startsWith('- '));
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Replace Performance Stats section with formatted stats. */
  updateStats(stats: SoulStats): void {
    const streakLabel = stats.currentStreak >= 0
      ? `${stats.currentStreak}W`
      : `${Math.abs(stats.currentStreak)}L`;

    const lines = [
      `- **Win rate:** ${stats.winRate.toFixed(1)}%`,
      `- **Avg win:** +${stats.avgWinPct.toFixed(2)}%  |  **Avg loss:** -${Math.abs(stats.avgLossPct).toFixed(2)}%`,
      `- **Profit factor:** ${stats.profitFactor.toFixed(2)}`,
      `- **Current streak:** ${streakLabel}`,
      `- **Session PnL:** ${stats.sessionPnlPct >= 0 ? '+' : ''}${stats.sessionPnlPct.toFixed(2)}%`,
      `- **Best pair:** ${stats.bestPair}  |  **Worst pair:** ${stats.worstPair}`,
      `- **Total trades:** ${stats.totalTrades}`,
    ];
    this.replaceSection('stats', lines.join('\n'));
  }

  /** Prepend a rejection entry. FIFO, max 10. */
  addRejection(rejection: SoulRejection): void {
    const ts = rejection.timestamp.replace('T', ' ').slice(0, 16);
    const entry = `- [${ts}] ${rejection.pair} ${rejection.action}: ${rejection.reason}`;

    const existing = this.readListEntries('rejections');
    const updated = [entry, ...existing].slice(0, 10);
    this.replaceSection('rejections', updated.join('\n'));
  }

  /** Prepend an invisible exit entry (SL/TP/AUTO_CLOSE hit). FIFO, max 10. */
  addInvisibleExit(exit: SoulInvisibleExit): void {
    const ts = exit.timestamp.replace('T', ' ').slice(0, 16);
    const sign = exit.pnlPct >= 0 ? '+' : '';
    const entry = `- [${ts}] ${exit.pair} ${exit.side}: ${exit.type} hit at ${sign}${exit.pnlPct.toFixed(1)}%`;

    const existing = this.readListEntries('invisibleExits');
    const updated = [entry, ...existing].slice(0, 10);
    this.replaceSection('invisibleExits', updated.join('\n'));
  }

  /** Prepend an external insight. FIFO, max 5. */
  addExternalInsight(insight: SoulInsight): void {
    const ts = insight.timestamp.replace('T', ' ').slice(0, 16);
    const entry = `- [${ts}] **${insight.source}:** ${insight.text}`;

    const existing = this.readListEntries('insights');
    const updated = [entry, ...existing].slice(0, 5);
    this.replaceSection('insights', updated.join('\n'));
  }

  /** Replace one or more narrative sections (identity, learned, failures, regime). */
  writeNarrativeSections(sections: {
    identity?: string;
    learned?: string;
    failures?: string;
    regime?: string;
  }): void {
    if (sections.identity !== undefined)  this.replaceSection('identity', sections.identity);
    if (sections.learned !== undefined)   this.replaceSection('learned', sections.learned);
    if (sections.failures !== undefined)  this.replaceSection('failures', sections.failures);
    if (sections.regime !== undefined)    this.replaceSection('regime', sections.regime);
  }
}
