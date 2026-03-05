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
  learned: '## What I\'ve Learned',
  failures: '## My Failure Patterns',
  regime: '## Current Regime View',
  insights: '## External Insights',
  stats: '## Performance Stats',
  rejections: '## Recent Rejections',
  invisibleExits: '## Invisible Exits',
  verifiedIntel: '## Verified Intelligence',
};

// ── Default template ────────────────────────────────────────────────────

export const TEMPLATE = `# Dynamic Memory

## What I've Learned

_Nothing yet — waiting for first trades._

## My Failure Patterns

_No patterns detected yet._

## Current Regime View

_No regime assessment yet._

## External Insights

_No external insights yet._

## Verified Intelligence

_No verified claims yet._

## Performance Stats

_No stats yet._

## Recent Rejections

_No rejections yet._

## Invisible Exits

_No invisible exits yet._
`;

// ── MemoryKeeper ────────────────────────────────────────────────────────
export class MemoryKeeper {
  private readonly memoryPath: string;
  private readonly memoryHistoryDir: string;

  constructor(memoryDir: string) {
    this.memoryPath = join(memoryDir, 'memory.md');
    this.memoryHistoryDir = join(memoryDir, 'docs', 'deepresult', 'memory_history');
    if (!existsSync(this.memoryPath)) {
      mkdirSync(dirname(this.memoryPath), { recursive: true });
      writeFileSync(this.memoryPath, TEMPLATE, 'utf-8');
    }
    if (!existsSync(this.memoryHistoryDir)) {
      mkdirSync(this.memoryHistoryDir, { recursive: true });
    }
  }

  /** Return full memory.md content. */
  read(): string {
    return readFileSync(this.memoryPath, 'utf-8');
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
      writeFileSync(this.memoryPath, content + '\n\n' + newContent + '\n', 'utf-8');
      return;
    }

    // Find the next `## ` heading (if any)
    const nextHeadingMatch = content.slice(bodyStart).match(/\n## /);
    const bodyEnd = nextHeadingMatch
      ? bodyStart + nextHeadingMatch.index!
      : content.length;

    const before = content.slice(0, bodyStart);
    const after = content.slice(bodyEnd);

    writeFileSync(this.memoryPath, before + '\n\n' + newContent + '\n' + after, 'utf-8');
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

  /** Write grounding results to Verified Intelligence section. Keep last 5. */
  writeVerifiedIntel(entries: Array<{
    claim: string;
    verified: boolean | null | undefined;
    confidence: number | undefined;
    summary: string | undefined;
    timestamp: string;
  }>): void {
    const last5 = entries.slice(-5);
    const lines = last5.map((e) => {
      const status = e.verified === true ? 'VERIFIED' : e.verified === false ? 'DEBUNKED' : 'UNCONFIRMED';
      const conf = e.confidence != null ? ` (${Math.round(e.confidence * 100)}%)` : '';
      return `- [${status}${conf}] ${e.claim} — ${e.summary ?? 'no details'} _(${e.timestamp})_`;
    });
    this.replaceSection('verifiedIntel', lines.join('\n'));
  }

  /** Replace one or more narrative sections (learned, failures, regime). */
  writeNarrativeSections(sections: {
    learned?: string;
    failures?: string;
    regime?: string;
  }): void {
    if (sections.learned !== undefined) this.replaceSection('learned', sections.learned);
    if (sections.failures !== undefined) this.replaceSection('failures', sections.failures);
    if (sections.regime !== undefined) this.replaceSection('regime', sections.regime);
  }

  /**
   * Reads current memory.md and saves it iteratively as a backup.
   */
  backupHistory(): void {
    if (!existsSync(this.memoryPath)) return;

    const now = new Date();
    // YYYY-MM-DDTHH-mm-ss
    const timestampStr = now.toISOString()
      .replace(/:\d+\.\d+Z$/, '') // remove seconds/ms
      .replace(/:/g, '-') + '-' + String(now.getSeconds()).padStart(2, '0');

    const backupPath = join(this.memoryHistoryDir, `memory_${timestampStr}.md`);
    const content = this.read();
    writeFileSync(backupPath, content, 'utf-8');
  }
}
