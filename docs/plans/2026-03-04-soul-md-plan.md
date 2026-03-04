# soul.md + SoulKeeper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent living identity document (`soul.md`) that gives the trading LLM memory, self-reflection, and external insight awareness — turning it from a stateless oracle into an adaptive agent.

**Architecture:** A `SoulKeeper` class manages `~/.indic-bot/soul.md` — a Markdown file with structured sections. Code auto-updates stats/rejections/invisible exits every cycle. LLM periodically rewrites narrative sections (identity, lessons, failures, regime view). External tools (audit, manual) can inject insights. The full soul.md is injected into the LLM prompt before market data.

**Tech Stack:** TypeScript ESM, Vitest, fs (readFileSync/writeFileSync), existing LLMClient.call()

---

## Task Dependency Graph

```
Task 1 (SoulKeeper class) ──┐
Task 2 (SoulKeeper tests)   │
                             ├─→ Task 5 (wire into TradingLoop)
Task 3 (soul prompt inject)  │   Task 6 (wire into index.ts)
Task 4 (soul review agent) ──┘   Task 7 (soul:insight CLI)
                                  Task 8 (TradingLoop tests)
                                  Task 9 (docs + CLAUDE.md)
```

**Group A (independent):** Tasks 1–4
**Group B (depends on A):** Tasks 5–9

---

### Task 1: Create SoulKeeper class

**Files:**
- Create: `src/memory/soul-keeper.ts`

**Step 1: Create the SoulKeeper class**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

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
  source: string;     // 'audit' | 'manual' | 'external'
  text: string;
  timestamp: string;
}

const TEMPLATE = `# Trading Soul

## Identity
I am a crypto futures trading agent. I trade BTC, ETH, SOL on Binance Futures using multi-timeframe technical analysis, news sentiment, and macro data. I aim for high-confidence confluence trades with strict risk management.

## What I've Learned
No trading history yet. Observing and learning.

## My Failure Patterns
No failures recorded yet.

## Current Regime View
No market regime assessment yet.

## External Insights
No external insights yet.

## Performance Stats
No trades yet.

## Recent Rejections
No rejections yet.

## Invisible Exits
No invisible exits yet.
`;

const SECTION_MARKERS: Record<string, string> = {
  identity: '## Identity',
  learned: "## What I've Learned",
  failures: '## My Failure Patterns',
  regime: '## Current Regime View',
  external: '## External Insights',
  stats: '## Performance Stats',
  rejections: '## Recent Rejections',
  invisible: '## Invisible Exits',
};

export class SoulKeeper {
  private soulPath: string;

  constructor(soulDir: string) {
    this.soulPath = join(soulDir, 'soul.md');
    this.ensureExists();
  }

  private ensureExists(): void {
    try {
      readFileSync(this.soulPath, 'utf-8');
    } catch {
      mkdirSync(dirname(this.soulPath), { recursive: true });
      writeFileSync(this.soulPath, TEMPLATE, 'utf-8');
    }
  }

  read(): string {
    return readFileSync(this.soulPath, 'utf-8');
  }

  /** Replace a named section's content (everything between this header and next ## header) */
  private replaceSection(sectionKey: string, newContent: string): void {
    const content = this.read();
    const marker = SECTION_MARKERS[sectionKey];
    if (!marker) return;

    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) return;

    const afterMarker = markerIdx + marker.length;
    // Find the next ## header (or end of file)
    const nextSectionIdx = content.indexOf('\n## ', afterMarker);
    const endIdx = nextSectionIdx === -1 ? content.length : nextSectionIdx;

    const updated = content.slice(0, afterMarker) + '\n' + newContent + '\n' + content.slice(endIdx);
    writeFileSync(this.soulPath, updated, 'utf-8');
  }

  updateStats(stats: SoulStats): void {
    const streakLabel = stats.currentStreak > 0
      ? `${stats.currentStreak} wins` : stats.currentStreak < 0
      ? `${Math.abs(stats.currentStreak)} losses` : 'even';

    const lines = [
      `- Total trades: ${stats.totalTrades}`,
      `- Win rate: ${stats.winRate.toFixed(0)}%`,
      `- Avg win: +${stats.avgWinPct.toFixed(1)}%, Avg loss: ${stats.avgLossPct.toFixed(1)}%`,
      `- Profit factor: ${stats.profitFactor.toFixed(2)}`,
      `- Current streak: ${streakLabel}`,
      `- Session P&L: ${stats.sessionPnlPct >= 0 ? '+' : ''}${stats.sessionPnlPct.toFixed(2)}%`,
      `- Best pair: ${stats.bestPair}, Worst pair: ${stats.worstPair}`,
    ];
    this.replaceSection('stats', lines.join('\n'));
  }

  addRejection(rejection: SoulRejection): void {
    const content = this.read();
    const marker = SECTION_MARKERS.rejections;
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) return;

    const afterMarker = markerIdx + marker.length;
    const nextSectionIdx = content.indexOf('\n## ', afterMarker);
    const endIdx = nextSectionIdx === -1 ? content.length : nextSectionIdx;
    const sectionContent = content.slice(afterMarker, endIdx).trim();

    // Parse existing entries, add new, keep max 10
    const existing = sectionContent.split('\n').filter(l => l.startsWith('- ['));
    const ts = rejection.timestamp.slice(0, 16).replace('T', ' ');
    const newEntry = `- [${ts}] ${rejection.pair} ${rejection.action}: ${rejection.reason}`;
    const entries = [newEntry, ...existing].slice(0, 10);

    this.replaceSection('rejections', entries.join('\n'));
  }

  addInvisibleExit(exit: SoulInvisibleExit): void {
    const content = this.read();
    const marker = SECTION_MARKERS.invisible;
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) return;

    const afterMarker = markerIdx + marker.length;
    const nextSectionIdx = content.indexOf('\n## ', afterMarker);
    const endIdx = nextSectionIdx === -1 ? content.length : nextSectionIdx;
    const sectionContent = content.slice(afterMarker, endIdx).trim();

    const existing = sectionContent.split('\n').filter(l => l.startsWith('- ['));
    const ts = exit.timestamp.slice(0, 16).replace('T', ' ');
    const sign = exit.pnlPct >= 0 ? '+' : '';
    const newEntry = `- [${ts}] ${exit.pair} ${exit.side}: ${exit.type} hit at ${sign}${exit.pnlPct.toFixed(1)}%`;
    const entries = [newEntry, ...existing].slice(0, 10);

    this.replaceSection('invisible', entries.join('\n'));
  }

  addExternalInsight(insight: SoulInsight): void {
    const content = this.read();
    const marker = SECTION_MARKERS.external;
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) return;

    const afterMarker = markerIdx + marker.length;
    const nextSectionIdx = content.indexOf('\n## ', afterMarker);
    const endIdx = nextSectionIdx === -1 ? content.length : nextSectionIdx;
    const sectionContent = content.slice(afterMarker, endIdx).trim();

    const existing = sectionContent.split('\n').filter(l => l.startsWith('- ['));
    const ts = insight.timestamp.slice(0, 16).replace('T', ' ');
    const newEntry = `- [${ts}] ${insight.source}: ${insight.text}`;
    const entries = [newEntry, ...existing].slice(0, 5);

    this.replaceSection('external', entries.join('\n'));
  }

  writeNarrativeSections(sections: {
    identity?: string;
    learned?: string;
    failures?: string;
    regime?: string;
  }): void {
    if (sections.identity) this.replaceSection('identity', sections.identity);
    if (sections.learned) this.replaceSection('learned', sections.learned);
    if (sections.failures) this.replaceSection('failures', sections.failures);
    if (sections.regime) this.replaceSection('regime', sections.regime);
  }
}
```

**Step 2: Run the full test suite to verify no import/compile issues**

Run: `npx vitest run`
Expected: All existing tests pass (87 tests).

**Step 3: Commit**

```bash
git add src/memory/soul-keeper.ts
git commit -m "feat: add SoulKeeper class — manages soul.md sections"
```

---

### Task 2: Add SoulKeeper unit tests

**Files:**
- Create: `tests/memory/soul-keeper.test.ts`

**Step 1: Write the tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { SoulKeeper } from '../../src/memory/soul-keeper.js';
import type { SoulStats, SoulRejection, SoulInvisibleExit, SoulInsight } from '../../src/memory/soul-keeper.js';

const TEST_DIR = join(process.cwd(), 'tmp-soul-test');

describe('SoulKeeper', () => {
  let sk: SoulKeeper;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    sk = new SoulKeeper(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates soul.md from template on first init', () => {
    const content = sk.read();
    expect(content).toContain('# Trading Soul');
    expect(content).toContain('## Identity');
    expect(content).toContain('## Performance Stats');
  });

  it('preserves existing soul.md on re-init', () => {
    const original = sk.read();
    const sk2 = new SoulKeeper(TEST_DIR);
    expect(sk2.read()).toBe(original);
  });

  it('updateStats replaces Performance Stats section', () => {
    const stats: SoulStats = {
      winRate: 60, avgWinPct: 3.2, avgLossPct: -1.5,
      profitFactor: 1.8, currentStreak: 3,
      sessionPnlPct: 2.5, bestPair: 'ETHUSDT', worstPair: 'SOLUSDT',
      totalTrades: 15,
    };
    sk.updateStats(stats);
    const content = sk.read();
    expect(content).toContain('Win rate: 60%');
    expect(content).toContain('Profit factor: 1.80');
    expect(content).toContain('3 wins');
    expect(content).toContain('Best pair: ETHUSDT');
    // Other sections untouched
    expect(content).toContain('## Identity');
    expect(content).toContain('No rejections yet.');
  });

  it('addRejection prepends entry, keeps max 10', () => {
    for (let i = 0; i < 12; i++) {
      sk.addRejection({
        pair: `PAIR${i}`, action: 'LONG',
        reason: `reason-${i}`, timestamp: `2026-03-04T${String(i).padStart(2, '0')}:00:00Z`,
      });
    }
    const content = sk.read();
    // Most recent first
    expect(content).toContain('PAIR11');
    expect(content).toContain('PAIR2');
    // Oldest trimmed
    expect(content).not.toContain('PAIR0');
    expect(content).not.toContain('PAIR1');
  });

  it('addInvisibleExit prepends entry with signed pnl', () => {
    sk.addInvisibleExit({
      pair: 'BTCUSDT', side: 'LONG', type: 'SL',
      pnlPct: -2.1, timestamp: '2026-03-04T12:00:00Z',
    });
    sk.addInvisibleExit({
      pair: 'ETHUSDT', side: 'SHORT', type: 'TP',
      pnlPct: 3.5, timestamp: '2026-03-04T14:00:00Z',
    });
    const content = sk.read();
    expect(content).toContain('BTCUSDT LONG: SL hit at -2.1%');
    expect(content).toContain('ETHUSDT SHORT: TP hit at +3.5%');
    // Most recent first
    expect(content.indexOf('ETHUSDT')).toBeLessThan(content.indexOf('BTCUSDT LONG: SL'));
  });

  it('addExternalInsight keeps max 5, FIFO', () => {
    for (let i = 0; i < 7; i++) {
      sk.addExternalInsight({
        source: 'audit', text: `insight-${i}`,
        timestamp: `2026-03-04T${String(i).padStart(2, '0')}:00:00Z`,
      });
    }
    const content = sk.read();
    expect(content).toContain('insight-6');
    expect(content).toContain('insight-2');
    expect(content).not.toContain('insight-0');
    expect(content).not.toContain('insight-1');
  });

  it('writeNarrativeSections updates only specified sections', () => {
    sk.writeNarrativeSections({
      identity: 'I am a cautious swing trader.',
      failures: 'I chase pumps too often.',
    });
    const content = sk.read();
    expect(content).toContain('I am a cautious swing trader.');
    expect(content).toContain('I chase pumps too often.');
    // Untouched sections keep defaults
    expect(content).toContain('No trading history yet.');  // learned — unchanged
    expect(content).toContain('No market regime assessment yet.'); // regime — unchanged
  });

  it('read() returns full soul.md content as string', () => {
    const content = sk.read();
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(100);
  });
});
```

**Step 2: Run the tests**

Run: `npx vitest run tests/memory/soul-keeper.test.ts`
Expected: All 7 tests pass.

**Step 3: Commit**

```bash
git add tests/memory/soul-keeper.test.ts
git commit -m "test: SoulKeeper unit tests — stats, rejections, exits, insights"
```

---

### Task 3: Add soul.md injection into LLM prompt

**Files:**
- Modify: `src/llm/prompts.ts:113-129` (EnrichedPromptData interface)
- Modify: `src/llm/prompts.ts:177-191` (buildEnrichedPrompt — add soul section)

**Step 1: Add `soulContent` field to EnrichedPromptData**

In `src/llm/prompts.ts`, add to the `EnrichedPromptData` interface (after line 128):

```typescript
// Add after riskStatus line:
  soulContent?: string;
```

The full interface becomes:
```typescript
export interface EnrichedPromptData {
  snapshots: MarketSnapshot[];
  indicators: Map<string, Indicators>;
  indicators4h?: Map<string, Indicators>;
  portfolio: PortfolioState;
  signals: TradingViewSignal[];
  news: CryptoNews[];
  fearGreed: FearGreedData;
  sessionNotes?: string;
  recentTrades?: TradeRecord[];
  newsAnalysis?: import('../news/news-cache.js').NewsAnalysis;
  recentNewsWithAge?: Array<CryptoNews & { age_hours: number }>;
  macroAnalysis?: MacroAnalysis;
  sessionPnlPct?: number;
  lastOrderResult?: string;
  riskStatus?: string;
  soulContent?: string;    // <-- NEW
}
```

**Step 2: Inject soul content into prompt**

In `buildEnrichedPrompt()` at line 191 (after session status block, before Technical Analysis), add:

```typescript
  // Soul — persistent identity & memory
  if (data.soulContent) {
    prompt += `## Soul (your persistent memory & identity)\n${data.soulContent}\n\n`;
  }
```

This places soul content BEFORE market data — the LLM reads its identity first, then analyses the market.

**Step 3: Run tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests pass (new field is optional, no existing test provides it).

**Step 4: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: inject soul.md content into LLM prompt"
```

---

### Task 4: Create soul review agent (LLM self-reflection)

**Files:**
- Create: `src/memory/soul-review.ts`

**Step 1: Create the soul review module**

```typescript
import type { LLMClient } from '../llm/client.js';
import type { SoulKeeper } from './soul-keeper.js';
import type { TradeRecord } from './session.js';

const SOUL_REVIEW_SYSTEM = `You are reviewing your own trading soul document — your persistent identity and memory as a crypto futures trading agent.

Your task: Update the narrative sections based on your recent performance and decisions. Be honest, specific, and actionable.

Respond with EXACTLY this JSON format:
{
  "identity": "2-4 sentences about who you are as a trader and your current style",
  "learned": "2-4 sentences about key lessons from recent trading",
  "failures": "2-4 sentences about recurring mistakes and patterns to avoid",
  "regime": "2-4 sentences about your current market view and bias"
}

Rules:
- Be brutally honest about failures — do not rationalize losses
- Reference specific pairs and patterns from your data
- Keep each section concise (2-4 sentences max)
- If win rate is low, acknowledge it. If you keep getting rejected, analyze why.
- Adapt your regime view based on recent market conditions`;

export interface SoulReviewDeps {
  llm: LLMClient;
  soulKeeper: SoulKeeper;
}

export class SoulReviewAgent {
  private llm: LLMClient;
  private soulKeeper: SoulKeeper;
  private lastReviewCycle = 0;
  private reviewIntervalCycles: number;

  constructor(deps: SoulReviewDeps, reviewIntervalCycles = 20) {
    this.llm = deps.llm;
    this.soulKeeper = deps.soulKeeper;
    this.reviewIntervalCycles = reviewIntervalCycles;
  }

  shouldReview(cycleCount: number, consecutiveLosses: number, sessionPnlPctDelta: number): boolean {
    // Every N cycles
    if (cycleCount - this.lastReviewCycle >= this.reviewIntervalCycles) return true;
    // After 3+ consecutive losses
    if (consecutiveLosses >= 3) return true;
    // After significant balance change (>3%)
    if (Math.abs(sessionPnlPctDelta) > 3) return true;
    return false;
  }

  async review(recentTrades: TradeRecord[], recentDecisions: string[]): Promise<void> {
    const currentSoul = this.soulKeeper.read();

    const userPrompt = `Here is your current soul document:

${currentSoul}

Recent closed trades (newest first):
${recentTrades.slice(0, 10).map(t => {
  const sign = t.pnlPct >= 0 ? '+' : '';
  return `- ${t.pair} ${t.action}: ${sign}${t.pnlPct.toFixed(1)}% (${sign}$${t.pnlUsd.toFixed(2)}) at ${t.closedAt}`;
}).join('\n') || 'No recent trades.'}

Recent decision log (last 10):
${recentDecisions.slice(0, 10).join('\n') || 'No recent decisions.'}

Update the four narrative sections.`;

    try {
      const response = await this.llm.call(SOUL_REVIEW_SYSTEM, userPrompt);

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*"identity"[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[SoulReview] Failed to parse LLM response');
        return;
      }

      const sections = JSON.parse(jsonMatch[0]) as {
        identity?: string;
        learned?: string;
        failures?: string;
        regime?: string;
      };

      this.soulKeeper.writeNarrativeSections(sections);
      this.lastReviewCycle = Date.now(); // Use timestamp for simplicity
      console.log('[SoulReview] Narrative sections updated');
    } catch (err) {
      console.error('[SoulReview] Review failed:', err);
    }
  }
}
```

**Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: All existing tests pass.

**Step 3: Commit**

```bash
git add src/memory/soul-review.ts
git commit -m "feat: add SoulReviewAgent — LLM self-reflection every 20 cycles"
```

---

### Task 5: Compute SoulStats from TradeRecord[]

**Files:**
- Create: `src/memory/soul-stats.ts`
- Create: `tests/memory/soul-stats.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { computeSoulStats } from '../../src/memory/soul-stats.js';
import type { TradeRecord } from '../../src/memory/session.js';

describe('computeSoulStats', () => {
  it('returns zero stats for empty trades', () => {
    const stats = computeSoulStats([], 0);
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
  });

  it('computes correct stats from trade history', () => {
    const trades: TradeRecord[] = [
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 5, pnlPct: 2.5, closedAt: '2026-03-04T10:00:00Z' },
      { pair: 'ETHUSDT', action: 'CLOSE', pnlUsd: -3, pnlPct: -1.5, closedAt: '2026-03-04T09:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 4, pnlPct: 2.0, closedAt: '2026-03-04T08:00:00Z' },
      { pair: 'SOLUSDT', action: 'CLOSE', pnlUsd: -2, pnlPct: -1.0, closedAt: '2026-03-04T07:00:00Z' },
      { pair: 'ETHUSDT', action: 'CLOSE', pnlUsd: 6, pnlPct: 3.0, closedAt: '2026-03-04T06:00:00Z' },
    ];

    const stats = computeSoulStats(trades, 1.2);
    expect(stats.totalTrades).toBe(5);
    expect(stats.winRate).toBe(60);
    expect(stats.avgWinPct).toBeCloseTo(2.5);      // (2.5+2.0+3.0)/3
    expect(stats.avgLossPct).toBeCloseTo(-1.25);    // (-1.5+-1.0)/2
    expect(stats.profitFactor).toBeCloseTo(3.0);    // 15/5 total wins/losses
    expect(stats.currentStreak).toBe(1);            // last trade is a win
    expect(stats.sessionPnlPct).toBe(1.2);
    expect(stats.bestPair).toBe('ETHUSDT');         // +3.0 net
    expect(stats.worstPair).toBe('SOLUSDT');        // -1.0 net
  });

  it('detects losing streaks', () => {
    const trades: TradeRecord[] = [
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: -1, pnlPct: -0.5, closedAt: '2026-03-04T12:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: -2, pnlPct: -1.0, closedAt: '2026-03-04T11:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: -3, pnlPct: -1.5, closedAt: '2026-03-04T10:00:00Z' },
      { pair: 'BTCUSDT', action: 'CLOSE', pnlUsd: 1, pnlPct: 0.5, closedAt: '2026-03-04T09:00:00Z' },
    ];
    const stats = computeSoulStats(trades, -2);
    expect(stats.currentStreak).toBe(-3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memory/soul-stats.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```typescript
import type { TradeRecord } from './session.js';
import type { SoulStats } from './soul-keeper.js';

export function computeSoulStats(trades: TradeRecord[], sessionPnlPct: number): SoulStats {
  if (trades.length === 0) {
    return {
      winRate: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0,
      currentStreak: 0, sessionPnlPct, bestPair: '-', worstPair: '-',
      totalTrades: 0,
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct < 0);

  const winRate = (wins.length / trades.length) * 100;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  const totalWinUsd = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const totalLossUsd = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor = totalLossUsd > 0 ? totalWinUsd / totalLossUsd : 0;

  // Current streak (trades[0] is most recent)
  let currentStreak = 0;
  const firstPnl = trades[0].pnlPct;
  if (firstPnl > 0) {
    for (const t of trades) {
      if (t.pnlPct > 0) currentStreak++;
      else break;
    }
  } else if (firstPnl < 0) {
    for (const t of trades) {
      if (t.pnlPct < 0) currentStreak--;
      else break;
    }
  }

  // Best/worst pair by net P&L
  const pairPnl = new Map<string, number>();
  for (const t of trades) {
    pairPnl.set(t.pair, (pairPnl.get(t.pair) ?? 0) + t.pnlUsd);
  }
  let bestPair = '-', worstPair = '-', bestVal = -Infinity, worstVal = Infinity;
  for (const [pair, pnl] of pairPnl) {
    if (pnl > bestVal) { bestVal = pnl; bestPair = pair; }
    if (pnl < worstVal) { worstVal = pnl; worstPair = pair; }
  }

  return {
    winRate, avgWinPct, avgLossPct, profitFactor,
    currentStreak, sessionPnlPct, bestPair, worstPair,
    totalTrades: trades.length,
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/memory/soul-stats.test.ts`
Expected: All 3 tests pass.

**Step 5: Commit**

```bash
git add src/memory/soul-stats.ts tests/memory/soul-stats.test.ts
git commit -m "feat: computeSoulStats — calculates win rate, streaks, pair performance"
```

---

### Task 6: Wire SoulKeeper into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts:17-48` (TradingLoopDeps — add soulKeeper)
- Modify: `src/trading-loop.ts:50-57` (class fields)
- Modify: `src/trading-loop.ts:191` (inject soul into llm.analyze)
- Modify: `src/trading-loop.ts:244` (add rejection to soul)
- Modify: `src/trading-loop.ts:111` (add auto-close to soul as invisible exit)
- Modify: `src/trading-loop.ts:299-305` (update stats after performance log)

**Step 1: Add SoulKeeper to deps**

In `TradingLoopDeps` interface (after line 47, before closing `}`):

```typescript
  soulKeeper?: import('./memory/soul-keeper.js').SoulKeeper;
  soulReview?: import('./memory/soul-review.js').SoulReviewAgent;
```

Add import at top of file:

```typescript
import { computeSoulStats } from './memory/soul-stats.js';
```

**Step 2: Inject soul content into LLM analyze call**

Before the `const decisions = await llm.analyze({` call (around line 191), add:

```typescript
      const soulContent = this.deps.soulKeeper?.read();
```

Then add `soulContent` to the analyze call object:

```typescript
      const decisions = await llm.analyze({
        snapshots,
        indicators,
        indicators4h,
        portfolio,
        signals,
        news: [],
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        newsAnalysis,
        recentNewsWithAge,
        macroAnalysis: this.lastMacroAnalysis,
        sessionPnlPct,
        lastOrderResult: this.deps.memory.getLastOrderResult(),
        riskStatus,
        soulContent,   // <-- NEW
      });
```

**Step 3: Record rejections to soul**

After the RISK_REJECTED log line (around line 244), add:

```typescript
          this.deps.soulKeeper?.addRejection({
            pair: decision.pair,
            action: decision.action,
            reason: validation.reason || 'unknown',
            timestamp: new Date().toISOString(),
          });
```

**Step 4: Record auto-close as invisible exit**

In the auto-exit section (after `logger.logTrade` around line 111), add:

```typescript
            this.deps.soulKeeper?.addInvisibleExit({
              pair: pos.pair,
              side: pos.side,
              type: 'AUTO_CLOSE',
              pnlPct: pos.unrealizedPnlPct,
              timestamp: new Date().toISOString(),
            });
```

**Step 5: Update soul stats after performance log**

After `this.cycleCount++` (around line 305), add:

```typescript
      // Update soul stats
      if (this.deps.soulKeeper) {
        const stats = computeSoulStats(
          this.deps.memory.load().recent_trades,
          sessionPnlPct,
        );
        this.deps.soulKeeper.updateStats(stats);
      }

      // Soul review (LLM self-reflection)
      if (this.deps.soulReview) {
        const streak = this.deps.memory.load().recent_trades.reduce((s, t) => {
          if (s === null) return t.pnlPct < 0 ? -1 : t.pnlPct > 0 ? 1 : 0;
          if (s > 0 && t.pnlPct > 0) return s + 1;
          if (s < 0 && t.pnlPct < 0) return s - 1;
          return null;
        }, null as number | null) ?? 0;
        const consecutiveLosses = streak < 0 ? Math.abs(streak) : 0;
        if (this.deps.soulReview.shouldReview(this.cycleCount, consecutiveLosses, sessionPnlPct)) {
          try {
            await this.deps.soulReview.review(
              this.deps.memory.load().recent_trades,
              [],  // decision log — future enhancement
            );
          } catch (err) {
            console.error('[SoulReview] Error:', err);
          }
        }
      }
```

**Step 6: Run tests**

Run: `npx vitest run`
Expected: All existing tests pass (soulKeeper is optional, not provided in mocks).

**Step 7: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat: wire SoulKeeper into TradingLoop — stats, rejections, auto-close exits"
```

---

### Task 7: Wire SoulKeeper into index.ts

**Files:**
- Modify: `src/index.ts:20-22` (imports)
- Modify: `src/index.ts:103-128` (TradingLoop construction)

**Step 1: Add imports**

After line 22 (SessionMemory import), add:

```typescript
import { SoulKeeper } from './memory/soul-keeper.js';
import { SoulReviewAgent } from './memory/soul-review.js';
```

**Step 2: Create SoulKeeper and SoulReviewAgent instances**

After the `memory` initialization (around line 32), add:

```typescript
  const soulKeeper = new SoulKeeper(join(process.env.HOME || '.', '.indic-bot'));
  const soulReview = new SoulReviewAgent({ llm, soulKeeper });
  console.log('[Soul] SoulKeeper + SoulReview initialized');
```

Add `join` import — it's already used in session.ts, but index.ts needs it:

```typescript
import { join } from 'path';
```

**Step 3: Pass to TradingLoop**

In the TradingLoop constructor (around line 103-128), add before the closing `}`):

```typescript
    soulKeeper,
    soulReview,
```

**Step 4: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire SoulKeeper + SoulReview into index.ts"
```

---

### Task 8: Create soul:insight CLI script

**Files:**
- Create: `scripts/soul-insight.ts`
- Modify: `package.json` (add script)

**Step 1: Create the CLI script**

```typescript
import { join } from 'path';
import { SoulKeeper } from '../src/memory/soul-keeper.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: npm run soul:insight "your insight text here"');
  process.exit(1);
}

const source = process.argv[2] === '--audit' ? 'audit' : 'manual';
const insightText = source === 'audit' ? process.argv.slice(3).join(' ').trim() : text;

const soulKeeper = new SoulKeeper(join(process.env.HOME || '.', '.indic-bot'));
soulKeeper.addExternalInsight({
  source,
  text: insightText,
  timestamp: new Date().toISOString(),
});

console.log(`[Soul] External insight added (${source}): ${insightText.slice(0, 80)}...`);
```

**Step 2: Add npm script to package.json**

In `package.json` scripts section, add:

```json
"soul:insight": "tsx scripts/soul-insight.ts"
```

**Step 3: Commit**

```bash
git add scripts/soul-insight.ts package.json
git commit -m "feat: add soul:insight CLI — inject external insights into soul.md"
```

---

### Task 9: Add TradingLoop tests for soul integration

**Files:**
- Modify: `tests/trading-loop.test.ts`

**Step 1: Add mockSoulKeeper to beforeEach**

In the `beforeEach` block (around line 18), add:

```typescript
    const mockSoulKeeper = {
      read: vi.fn().mockReturnValue('# Trading Soul\n## Identity\nTest soul'),
      updateStats: vi.fn(),
      addRejection: vi.fn(),
      addInvisibleExit: vi.fn(),
      addExternalInsight: vi.fn(),
      writeNarrativeSections: vi.fn(),
    };
```

Pass it into the TradingLoop constructor:

```typescript
    loop = new TradingLoop({
      // ... existing deps ...
      soulKeeper: mockSoulKeeper as any,
    });
```

**Step 2: Add test — soul content passed to LLM**

```typescript
  it('passes soul content to llm.analyze', async () => {
    await loop.runOnce();

    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.soulContent).toContain('Trading Soul');
  });
```

**Step 3: Add test — rejection recorded in soul**

```typescript
  it('records RISK_REJECTED in soul', async () => {
    mockRisk.validate.mockReturnValue({ approved: false, reason: 'too risky' });
    const mockSK = (loop as any).deps.soulKeeper;

    await loop.runOnce();

    expect(mockSK.addRejection).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'BTCUSDT', reason: 'too risky' }),
    );
  });
```

**Step 4: Add test — auto-close recorded as invisible exit**

```typescript
  it('records auto-close as invisible exit in soul', async () => {
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 100, sessionPnl: 0,
      positions: [{
        pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG',
        entryPrice: 50000, unrealizedPnlPct: 0.3, heldHours: 9,
      }],
    });
    mockOrders.close.mockResolvedValue({ success: true, orderId: 99 });
    mockLlm.analyze.mockResolvedValue([]);
    const mockSK = (loop as any).deps.soulKeeper;

    await loop.runOnce();

    expect(mockSK.addInvisibleExit).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'BTCUSDT', type: 'AUTO_CLOSE' }),
    );
  });
```

**Step 5: Add test — stats updated after cycle**

```typescript
  it('updates soul stats after each cycle', async () => {
    mockLlm.analyze.mockResolvedValue([]);
    const mockSK = (loop as any).deps.soulKeeper;

    await loop.runOnce();

    expect(mockSK.updateStats).toHaveBeenCalled();
  });
```

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (existing + 4 new).

**Step 7: Commit**

```bash
git add tests/trading-loop.test.ts
git commit -m "test: TradingLoop soul integration — content, rejections, exits, stats"
```

---

### Task 10: Update docs and CLAUDE.md

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CLAUDE.md`

**Step 1: Add Soul section to ARCHITECTURE.md**

After the Risk Management section, add:

```markdown
## Soul System

The bot maintains a persistent identity document (`~/.indic-bot/soul.md`) that gives the LLM agent memory, self-reflection, and external insight awareness.

### Components

| Component | File | Purpose |
|-----------|------|---------|
| SoulKeeper | `src/memory/soul-keeper.ts` | Reads/writes soul.md sections |
| SoulReviewAgent | `src/memory/soul-review.ts` | LLM self-reflection (every ~20 cycles) |
| computeSoulStats | `src/memory/soul-stats.ts` | Computes win rate, streaks, pair performance |
| soul:insight CLI | `scripts/soul-insight.ts` | Manual/external insight injection |

### Soul Document Structure

| Section | Author | Update Frequency |
|---------|--------|-----------------|
| Identity | LLM (SoulReview) | Every ~20 cycles or after 3 losses |
| What I've Learned | LLM (SoulReview) | Same triggers |
| My Failure Patterns | LLM (SoulReview) | Same triggers |
| Current Regime View | LLM (SoulReview) | Same triggers |
| External Insights | External tools / manual | On-demand (max 5 entries) |
| Performance Stats | SoulKeeper (code) | Every cycle |
| Recent Rejections | SoulKeeper (code) | On each RISK_REJECTED (max 10) |
| Invisible Exits | SoulKeeper (code) | On AUTO_CLOSE (max 10) |

### Data Flow

1. **Every cycle**: SoulKeeper.updateStats() writes Performance Stats from last 20 trades
2. **On rejection**: SoulKeeper.addRejection() records RISK_REJECTED with reason
3. **On auto-close**: SoulKeeper.addInvisibleExit() records stale/max-hold exits
4. **Before LLM call**: soul.md content injected into prompt (before market data)
5. **Every ~20 cycles**: SoulReviewAgent sends soul.md + recent trades to LLM → updates narrative sections
6. **On-demand**: `npm run soul:insight "text"` adds external insight
```

**Step 2: Update CLAUDE.md**

In the Architecture section, add after the Persistent state description:

```markdown
**Soul system** (`src/memory/`):
- `soul-keeper.ts` — manages `~/.indic-bot/soul.md` with section-level read/write
- `soul-review.ts` — LLM self-reflection agent, updates narrative sections every ~20 cycles
- `soul-stats.ts` — computes SoulStats (win rate, streaks, pair performance) from TradeRecord[]
- `scripts/soul-insight.ts` — CLI for injecting external insights (`npm run soul:insight "text"`)
```

In the Commands section, add:

```bash
npm run soul:insight "text" # inject external insight into soul.md
```

**Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md CLAUDE.md
git commit -m "docs: soul.md system — architecture, CLAUDE.md, CLI usage"
```

---

## Summary

| Task | Description | Files | Tests |
|------|-------------|-------|-------|
| 1 | SoulKeeper class | `src/memory/soul-keeper.ts` | — |
| 2 | SoulKeeper tests | `tests/memory/soul-keeper.test.ts` | 7 |
| 3 | Prompt injection | `src/llm/prompts.ts` | — |
| 4 | Soul review agent | `src/memory/soul-review.ts` | — |
| 5 | computeSoulStats | `src/memory/soul-stats.ts`, `tests/memory/soul-stats.test.ts` | 3 |
| 6 | Wire into TradingLoop | `src/trading-loop.ts` | — |
| 7 | Wire into index.ts | `src/index.ts` | — |
| 8 | soul:insight CLI | `scripts/soul-insight.ts`, `package.json` | — |
| 9 | TradingLoop soul tests | `tests/trading-loop.test.ts` | 4 |
| 10 | Documentation | `docs/ARCHITECTURE.md`, `CLAUDE.md` | — |

**Total: 10 tasks, ~14 new tests, 6 new files, 4 modified files**
