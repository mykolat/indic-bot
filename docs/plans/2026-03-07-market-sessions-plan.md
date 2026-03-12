# Market Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session-aware context layer that tells the LLM what market session it is as a weak prior, requiring explicit confirmation/rejection against real market data.

**Architecture:** New `src/market/session.ts` module provides session detection + metadata. `prompts.ts` injects a neutral session block into the enriched prompt. LLM outputs `session_context` fields which are logged to journal and DB for attribution analytics.

**Tech Stack:** TypeScript, Vitest, PostgreSQL (Supabase)

**Design doc:** `docs/plans/2026-03-07-market-sessions-design.md`

---

### Task 1: Session Detector — Tests

**Files:**
- Create: `tests/market/session.test.ts`

**Step 1: Write tests for getMarketSession()**

```ts
import { describe, it, expect } from 'vitest';
import { getMarketSession, getSessionMetadata, type MarketSession } from '../../src/market/session.js';

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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/market/session.test.ts`
Expected: FAIL — module `../../src/market/session.js` does not exist

**Step 3: Commit**

```bash
git add tests/market/session.test.ts
git commit -m "test: add failing tests for market session detector"
```

---

### Task 2: Session Detector — Implementation

**Files:**
- Create: `src/market/session.ts`

**Step 1: Implement getMarketSession() and metadata**

```ts
export type MarketSession =
  | 'asia_dead_zone'
  | 'london_open'
  | 'london_continuation'
  | 'london_ny_overlap'
  | 'ny_session'
  | 'ny_close_evening';

export interface SessionMetadata {
  name: string;
  utcRange: string;
  typicalTendencies: string[];
  cautions: string[];
  confirmationSignals: string[];
  rejectionSignals: string[];
}

export function getMarketSession(nowUtc: Date): MarketSession {
  const h = nowUtc.getUTCHours();
  if (h >= 0 && h < 6) return 'asia_dead_zone';
  if (h >= 6 && h < 10) return 'london_open';
  if (h >= 10 && h < 13) return 'london_continuation';
  if (h >= 13 && h < 17) return 'london_ny_overlap';
  if (h >= 17 && h < 21) return 'ny_session';
  return 'ny_close_evening';
}

const SESSION_METADATA: Record<MarketSession, SessionMetadata> = {
  asia_dead_zone: {
    name: 'Asia Session',
    utcRange: '00:00-06:00 UTC',
    typicalTendencies: [
      'lower participation',
      'weaker directional conviction',
      'more range-bound behavior',
    ],
    cautions: [
      'do not assume low activity if volume or event activity is elevated',
    ],
    confirmationSignals: ['subdued volume (<0.5x)', 'weak follow-through', 'low ADX (<20)'],
    rejectionSignals: ['volume expansion (>1x)', 'strong news catalyst', 'breakout structure', 'liquidation activity'],
  },
  london_open: {
    name: 'London Open',
    utcRange: '06:00-10:00 UTC',
    typicalTendencies: [
      'higher participation than Asia',
      'higher probability of directional moves',
      'institutional flow begins',
    ],
    cautions: [
      'confirm with real volume/ADX/price expansion before assuming directional session',
    ],
    confirmationSignals: ['volume spike (>1.2x)', 'ADX rising above 25', 'clear EMA alignment'],
    rejectionSignals: ['volume stays subdued', 'no follow-through on initial move', 'mixed signals across pairs'],
  },
  london_continuation: {
    name: 'London Continuation',
    utcRange: '10:00-13:00 UTC',
    typicalTendencies: [
      'transition period between London open and NY pre-market',
      'volume may plateau or dip',
      'trends from London open may extend or consolidate',
    ],
    cautions: [
      'do not assume continuation of earlier trends without fresh confirmation',
    ],
    confirmationSignals: ['sustained volume', 'trend extension with higher highs/lows', 'ADX still rising'],
    rejectionSignals: ['volume fading', 'price consolidation', 'divergences forming'],
  },
  london_ny_overlap: {
    name: 'London / NY Overlap',
    utcRange: '13:00-17:00 UTC',
    typicalTendencies: [
      'highest participation of the day',
      'highest probability of breakouts and large moves',
      'two major sessions active simultaneously',
    ],
    cautions: [
      'high participation does not guarantee directional clarity — confirm with price action',
    ],
    confirmationSignals: ['volume >1.5x average', 'ATR expanding', 'price breaking key levels'],
    rejectionSignals: ['volume normal despite overlap hours', 'choppy price action', 'no breakout structure'],
  },
  ny_session: {
    name: 'NY Session',
    utcRange: '17:00-21:00 UTC',
    typicalTendencies: [
      'volume normalizing after overlap',
      'mixed signals more common',
      'trend continuation or mean reversion both possible',
    ],
    cautions: [
      'do not assume strong trends will continue — momentum often fades',
    ],
    confirmationSignals: ['sustained volume', 'clear trend structure intact', 'no reversal signals'],
    rejectionSignals: ['volume dropping sharply', 'divergences on multiple timeframes', 'range compression'],
  },
  ny_close_evening: {
    name: 'NY Close / Evening',
    utcRange: '21:00-00:00 UTC',
    typicalTendencies: [
      'volume dropping toward daily low',
      'less reliable directional signals',
      'potential for late-day volatility spikes on low liquidity',
    ],
    cautions: [
      'low-liquidity moves can be deceptive — wider spreads, easier to get stopped out',
    ],
    confirmationSignals: ['volume truly low and stable', 'no pending macro events', 'price in tight range'],
    rejectionSignals: ['unexpected volume spike', 'news catalyst', 'liquidation cascade', 'extreme Fear & Greed shift'],
  },
};

export function getSessionMetadata(session: MarketSession): SessionMetadata {
  return SESSION_METADATA[session];
}

export function formatSessionPromptBlock(nowUtc: Date): string {
  const session = getMarketSession(nowUtc);
  const meta = SESSION_METADATA[session];

  let block = `## Current Market Session\n`;
  block += `Session: ${meta.name} (${meta.utcRange})\n\n`;
  block += `Typical tendencies:\n`;
  for (const t of meta.typicalTendencies) block += `- ${t}\n`;
  block += `\nConfirm with: ${meta.confirmationSignals.join(', ')}\n`;
  block += `Reject if: ${meta.rejectionSignals.join(', ')}\n`;
  block += `\nIMPORTANT: Treat this as a weak prior, not a rule.\n`;
  block += `Do not assume the session pattern is active unless market data confirms it.\n`;
  block += `You must explicitly assess: does current market data confirm, contradict, or make this session context irrelevant?\n`;

  return block;
}
```

**Step 2: Run tests**

Run: `npx vitest run tests/market/session.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/market/session.ts
git commit -m "feat: add market session detector with metadata and prompt formatter"
```

---

### Task 3: Add session_context to LLM Output Schema

**Files:**
- Modify: `src/llm/prompts.ts:97-123` — add `session_context` to JSON schema in `buildSystemPrompt()`
- Modify: `src/risk/manager.ts:3` — add `session_context` to `TradeDecision` interface

**Step 1: Add session_context to TradeDecision interface**

In `src/risk/manager.ts`, add to `TradeDecision` (after line 12):

```ts
  session_context?: {
    session_pattern_active: boolean;
    session_fit_score: number;
    session_role: 'supports' | 'neutral' | 'contradicts';
    session_reason: string;
  };
```

**Step 2: Update JSON schema in buildSystemPrompt()**

In `src/llm/prompts.ts`, modify the JSON schema block (lines 97-113). After the `"confidence"` field (line 109), add:

```
      "session_context": {
        "session_pattern_active": true|false,
        "session_fit_score": <0-100>,
        "session_role": "supports" | "neutral" | "contradicts",
        "session_reason": "<1 sentence: why session pattern is/isn't relevant>"
      }
```

**Step 3: Update next_check_minutes guide**

In `src/llm/prompts.ts`, modify lines 115-120. Add session-aware guidance after the existing lines:

```
- Session context: use session tendencies only if confirmed by actual volume/ADX/price action. Do not default to session-typical cadence.
```

**Step 4: Run existing tests to check nothing broke**

Run: `npx vitest run tests/`
Expected: ALL PASS (session_context is optional, so no existing tests should break)

**Step 5: Commit**

```bash
git add src/risk/manager.ts src/llm/prompts.ts
git commit -m "feat: add session_context to LLM decision schema"
```

---

### Task 4: Inject Session Block into buildEnrichedPrompt()

**Files:**
- Modify: `src/llm/prompts.ts:133-179` — add `sessionBlock` to `EnrichedPromptData`
- Modify: `src/llm/prompts.ts:227+` — insert session block into `buildEnrichedPrompt()`
- Modify: `src/llm/prompts.ts:208-215` — replace old `getTradingSession()`

**Step 1: Add sessionBlock to EnrichedPromptData**

In `src/llm/prompts.ts`, add to `EnrichedPromptData` interface (after line 169):

```ts
  sessionBlock?: string;
```

**Step 2: Replace getTradingSession() with session import**

Delete the old `getTradingSession()` function (lines 208-215). Update `formatCurrentTime()` (lines 217-225) to use the new session module:

```ts
import { getMarketSession, getSessionMetadata } from '../market/session.js';

function formatCurrentTime(): string {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = days[now.getUTCDay()];
  const h = now.getUTCHours().toString().padStart(2, '0');
  const m = now.getUTCMinutes().toString().padStart(2, '0');
  const session = getSessionMetadata(getMarketSession(now)).name;
  return `${now.toISOString().slice(0, 10)} ${h}:${m} UTC (${day}) — ${session}`;
}
```

**Step 3: Insert session block into buildEnrichedPrompt()**

In `buildEnrichedPrompt()`, after the regime section (around line 265, after `prompt += `NOTE: If your narrative...`) and before the pairRegimes section, add:

```ts
  if (data.sessionBlock) {
    prompt += data.sessionBlock + '\n';
  }
```

**Step 4: Run tests**

Run: `npx vitest run tests/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: inject session block into enriched prompt, replace old getTradingSession"
```

---

### Task 5: Wire Session into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts:244+` — call getMarketSession() and formatSessionPromptBlock() in runOnce()

**Step 1: Add import**

At top of `src/trading-loop.ts`, add:

```ts
import { getMarketSession, formatSessionPromptBlock } from './market/session.js';
```

**Step 2: Call formatSessionPromptBlock() and pass to promptData**

In `runOnce()`, find where `promptData` is assembled (around lines 720-755). Add the session block:

```ts
const sessionBlock = formatSessionPromptBlock(new Date());
```

And add to the promptData object:

```ts
sessionBlock,
```

**Step 3: Run tests**

Run: `npx vitest run tests/`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat: wire market session into trading loop prompt data"
```

---

### Task 6: Log Session Context to Decision Journal

**Files:**
- Modify: `src/logging/decision-journal.ts:13-24` — add session fields to JournalEntry
- Modify: `src/logging/decision-journal.ts:29-49` — log session fields
- Modify: `src/trading-loop.ts` — pass session context when logging journal entries

**Step 1: Add session fields to JournalEntry**

In `src/logging/decision-journal.ts`, add to `JournalEntry` interface (after line 23):

```ts
    session?: string;
    sessionPatternActive?: boolean;
    sessionFitScore?: number;
    sessionRole?: string;
    sessionReason?: string;
```

**Step 2: Log session fields in DecisionJournal.log()**

In the `JSON.stringify` block (lines 32-44), add after `indicators_snapshot`:

```ts
                session: entry.session,
                session_pattern_active: entry.sessionPatternActive,
                session_fit_score: entry.sessionFitScore,
                session_role: entry.sessionRole,
                session_reason: entry.sessionReason,
```

**Step 3: Pass session context from TradingLoop**

In `src/trading-loop.ts`, find where `this.deps.journal?.log()` is called. Add session fields from the decision's `session_context` and the current session:

```ts
session: getMarketSession(new Date()),
sessionPatternActive: decision.session_context?.session_pattern_active,
sessionFitScore: decision.session_context?.session_fit_score,
sessionRole: decision.session_context?.session_role,
sessionReason: decision.session_context?.session_reason,
```

**Step 4: Run tests**

Run: `npx vitest run tests/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/logging/decision-journal.ts src/trading-loop.ts
git commit -m "feat: log session context to decision journal"
```

---

### Task 7: DB Migration — Add Session Fields

**Files:**
- Modify: `src/db/types.ts:49-68` — add session fields to DbTradeDecision
- Modify: `src/db/repository.ts:62-72` — update insertTradeDecision query

**Step 1: Add fields to DbTradeDecision**

In `src/db/types.ts`, add after `confluence_factors` (line 66):

```ts
  session?: string;
  session_pattern_active?: boolean;
  session_fit_score?: number;
  session_role?: string;
  session_reason?: string;
```

**Step 2: Create Supabase migration**

Use `mcp__supabase__apply_migration` to add columns:

```sql
ALTER TABLE trade_decisions
  ADD COLUMN IF NOT EXISTS session text,
  ADD COLUMN IF NOT EXISTS session_pattern_active boolean,
  ADD COLUMN IF NOT EXISTS session_fit_score smallint,
  ADD COLUMN IF NOT EXISTS session_role text,
  ADD COLUMN IF NOT EXISTS session_reason text;
```

**Step 3: Update insertTradeDecision()**

In `src/db/repository.ts`, update the INSERT query (lines 63-70) to include the new columns:

Add `session, session_pattern_active, session_fit_score, session_role, session_reason` to both the column list and VALUES placeholders. Add corresponding values to the params array.

**Step 4: Update TradingLoop insertTradeDecision call**

In `src/trading-loop.ts` (around line 1025), add session fields to the insertTradeDecision call:

```ts
session: getMarketSession(new Date()),
session_pattern_active: decision.session_context?.session_pattern_active,
session_fit_score: decision.session_context?.session_fit_score,
session_role: decision.session_context?.session_role,
session_reason: decision.session_context?.session_reason,
```

**Step 5: Run tests**

Run: `npx vitest run tests/`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/db/types.ts src/db/repository.ts src/trading-loop.ts
git commit -m "feat: persist session context to trade_decisions table"
```

---

### Task 8: Integration Test — Session in Prompt Output

**Files:**
- Create: `tests/market/session-prompt.test.ts`

**Step 1: Write integration test**

```ts
import { describe, it, expect } from 'vitest';
import { formatSessionPromptBlock, getMarketSession } from '../../src/market/session.js';

describe('formatSessionPromptBlock', () => {
  it('includes session name and neutral language', () => {
    const block = formatSessionPromptBlock(new Date('2026-03-07T03:00:00Z'));
    expect(block).toContain('Asia Session');
    expect(block).toContain('weak prior');
    expect(block).toContain('Confirm with');
    expect(block).toContain('Reject if');
    // Must NOT contain biased language
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
```

**Step 2: Run tests**

Run: `npx vitest run tests/market/session-prompt.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add tests/market/session-prompt.test.ts
git commit -m "test: integration tests for session prompt block — neutral language"
```

---

### Task 9: Final Verification

**Step 1: Run full test suite**

Run: `npx vitest run tests/`
Expected: ALL PASS

**Step 2: Build check**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Verify git status clean**

Run: `git status`
Expected: On branch, all committed

---

## Summary of Changes

| File | Change |
|---|---|
| `src/market/session.ts` | **NEW** — session detector, metadata, prompt formatter |
| `src/llm/prompts.ts` | Add session block to prompt, replace old getTradingSession(), add session_context to schema |
| `src/risk/manager.ts` | Add optional session_context to TradeDecision |
| `src/trading-loop.ts` | Wire session into promptData, journal, and DB insert |
| `src/logging/decision-journal.ts` | Add session fields to journal entry |
| `src/db/types.ts` | Add session fields to DbTradeDecision |
| `src/db/repository.ts` | Update insertTradeDecision with session columns |
| `tests/market/session.test.ts` | **NEW** — unit tests for detector |
| `tests/market/session-prompt.test.ts` | **NEW** — integration tests for prompt block |
| DB migration | Add 5 columns to trade_decisions table |
