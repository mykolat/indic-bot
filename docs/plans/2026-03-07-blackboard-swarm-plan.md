# Blackboard Swarm Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace sequential message-based swarm debate with Blackboard Pattern (shared state, parallel reads, conflict-only reruns) + add framer-motion animations to the existing Swarm chat UI.

**Architecture:** Backend: SwarmBlackboard class manages shared state; all personas read board + write updates in parallel; Judge evaluates conflicts; max 3 rounds. Frontend: framer-motion for message animations, new ConflictCard + BlackboardStateCard components.

**Tech Stack:** TypeScript ESM, Vitest, React 19, Tailwind 4, framer-motion, Supabase (PG + REST)

**Design doc:** `docs/plans/2026-03-07-blackboard-swarm-design.md`

---

## Existing File Map

```
# Frontend (dashboard/)
src/pages/Swarm.tsx                        -- main page: sidebar + chat + superuser input
src/components/swarm/SwarmChatMessage.tsx   -- persona message bubble (emoji, vote badge, reply quote)
src/components/swarm/DebateSidebar.tsx      -- sidebar with debate list, vote dots
src/components/swarm/LevelDivider.tsx       -- hr between levels
src/lib/supabase.ts                        -- Supabase client

# Backend (src/)
src/llm/swarm-agent.ts                     -- SwarmAgent class (dynamic 1-5 level loop)
src/llm/prompts.ts                         -- buildExpertSystemPrompt, buildLevelJudgePrompt
src/llm/swarm-fingerprint.ts               -- fingerprint dedup
src/db/types.ts                            -- DbSwarmPersona interface
src/db/repository.ts                       -- insertSwarmPersona, insertLlmConversation
tests/llm/swarm-agent.test.ts              -- SwarmAgent tests (10 tests)
```

---

## Task 1: Install framer-motion + animate existing messages

**Files:**
- Modify: `dashboard/package.json`
- Modify: `dashboard/src/components/swarm/SwarmChatMessage.tsx`
- Modify: `dashboard/src/components/swarm/LevelDivider.tsx`
- Modify: `dashboard/src/pages/Swarm.tsx`

**Step 1: Install framer-motion**

```bash
cd dashboard && npm install framer-motion
```

**Step 2: Animate SwarmChatMessage**

Wrap the outer `<div>` with `motion.div` from framer-motion. Add slide-in animation:

```tsx
import { motion } from 'framer-motion';

// In the component, replace outer <div> with:
<motion.div
  initial={{ opacity: 0, x: isOutgoing ? 30 : -30 }}
  animate={{ opacity: 1, x: 0 }}
  transition={{ duration: 0.3, ease: 'easeOut' }}
  className={`flex gap-3 ${isOutgoing ? 'flex-row-reverse' : ''}`}
>
  {/* ...existing content... */}
</motion.div>
```

For superuser messages, add a gold shimmer keyframe via inline style or Tailwind.

**Step 3: Animate LevelDivider**

```tsx
import { motion } from 'framer-motion';

// Replace the outer <div> and inner line divs:
<motion.div
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  transition={{ duration: 0.5 }}
  className="flex items-center gap-3 py-3"
>
  <motion.div
    initial={{ scaleX: 0 }}
    animate={{ scaleX: 1 }}
    transition={{ duration: 0.5, ease: 'easeOut' }}
    className="flex-1 h-px bg-zinc-800 origin-right"
  />
  <motion.span
    initial={{ opacity: 0, y: -5 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3, delay: 0.2 }}
    className="text-xs text-zinc-500 font-medium shrink-0"
  >
    Level {level}: {label || labels[level] || `Round ${level}`}
  </motion.span>
  <motion.div
    initial={{ scaleX: 0 }}
    animate={{ scaleX: 1 }}
    transition={{ duration: 0.5, ease: 'easeOut' }}
    className="flex-1 h-px bg-zinc-800 origin-left"
  />
</motion.div>
```

**Step 4: Add stagger to message list in Swarm.tsx**

Wrap the messages rendering with `AnimatePresence`:

```tsx
import { AnimatePresence } from 'framer-motion';

// In renderMessages, wrap return:
<AnimatePresence mode="wait">
  {elements}
</AnimatePresence>
```

**Step 5: Verify dashboard builds**

```bash
cd dashboard && npm run build
```

**Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): add framer-motion animations to swarm chat messages"
```

---

## Task 2: SwarmBlackboard class + merge logic

**Files:**
- Create: `src/llm/swarm-blackboard.ts`
- Test: `tests/llm/swarm-blackboard.test.ts`

**Step 1: Write failing tests**

Create `tests/llm/swarm-blackboard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SwarmBlackboard } from '../../src/llm/swarm-blackboard.js';

describe('SwarmBlackboard', () => {
  it('initializes with market data', () => {
    const bb = new SwarmBlackboard({
      pairs: ['BTCUSDT'],
      regime: 'BearTrend',
      fearGreed: 18,
      volumeRatio: 2.1,
    });
    const state = bb.getState();
    expect(state.market.pairs).toEqual(['BTCUSDT']);
    expect(state.market.regime).toBe('BearTrend');
    expect(state.signals.bullish).toEqual([]);
    expect(state.votes).toEqual({});
    expect(state.conflicts).toEqual([]);
  });

  it('merges persona update into state', () => {
    const bb = new SwarmBlackboard({
      pairs: ['BTCUSDT'], regime: 'BearTrend', fearGreed: 18, volumeRatio: 2.1,
    });
    bb.mergePersonaUpdate('RM', {
      signals: { bullish: [], bearish: ['funding_high'], neutral: [] },
      vote: { d: 'HOLD', c: 90, prob: 30, reason: 'liq_risk' },
      risks: ['liq_cascade'],
      conflicts_with: {},
    });
    const state = bb.getState();
    expect(state.votes['RM']).toEqual({ d: 'HOLD', c: 90, prob: 30, reason: 'liq_risk' });
    expect(state.signals.bearish).toContain('funding_high');
    expect(state.risks).toContain('liq_cascade');
  });

  it('deduplicates signals across personas', () => {
    const bb = new SwarmBlackboard({
      pairs: ['BTCUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.0,
    });
    bb.mergePersonaUpdate('RM', {
      signals: { bullish: ['ema_bounce'], bearish: ['funding_high'], neutral: [] },
      vote: { d: 'HOLD', c: 80, prob: 40, reason: 'risk' },
      risks: ['liq_risk'],
      conflicts_with: {},
    });
    bb.mergePersonaUpdate('BT', {
      signals: { bullish: ['ema_bounce', 'rsi_oversold'], bearish: [], neutral: [] },
      vote: { d: 'LONG', c: 65, prob: 70, reason: 'bounce' },
      risks: [],
      conflicts_with: { 'RM': 'liq_risk_overstated' },
    });
    const state = bb.getState();
    // ema_bounce should appear only once
    expect(state.signals.bullish.filter(s => s === 'ema_bounce')).toHaveLength(1);
    expect(state.signals.bullish).toContain('rsi_oversold');
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].between).toContain('BT');
    expect(state.conflicts[0].between).toContain('RM');
  });

  it('detects high severity conflict when votes oppose', () => {
    const bb = new SwarmBlackboard({
      pairs: ['BTCUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.5,
    });
    bb.mergePersonaUpdate('BT', {
      signals: { bullish: ['bounce'], bearish: [], neutral: [] },
      vote: { d: 'LONG', c: 80, prob: 75, reason: 'reversal' },
      risks: [],
      conflicts_with: {},
    });
    bb.mergePersonaUpdate('BA', {
      signals: { bullish: [], bearish: ['breakdown'], neutral: [] },
      vote: { d: 'SHORT', c: 75, prob: 70, reason: 'bear_cont' },
      risks: [],
      conflicts_with: { 'BT': 'false_bounce' },
    });
    const state = bb.getState();
    expect(state.conflicts[0].severity).toBe('high');
  });

  it('getConflictingSpeakers returns persona codes with high conflicts', () => {
    const bb = new SwarmBlackboard({
      pairs: ['BTCUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.0,
    });
    bb.mergePersonaUpdate('BT', {
      signals: { bullish: ['x'], bearish: [], neutral: [] },
      vote: { d: 'LONG', c: 80, prob: 75, reason: 'up' },
      risks: [],
      conflicts_with: {},
    });
    bb.mergePersonaUpdate('BA', {
      signals: { bullish: [], bearish: ['y'], neutral: [] },
      vote: { d: 'SHORT', c: 75, prob: 70, reason: 'down' },
      risks: [],
      conflicts_with: { 'BT': 'disagree' },
    });
    bb.mergePersonaUpdate('RM', {
      signals: { bullish: [], bearish: [], neutral: ['z'] },
      vote: { d: 'HOLD', c: 90, prob: 30, reason: 'wait' },
      risks: [],
      conflicts_with: {},
    });
    const speakers = bb.getConflictingSpeakers();
    expect(speakers).toContain('BT');
    expect(speakers).toContain('BA');
    expect(speakers).not.toContain('RM');
  });

  it('toJSON returns compact serializable state', () => {
    const bb = new SwarmBlackboard({
      pairs: ['BTCUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.0,
    });
    const json = bb.toJSON();
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.market).toBeDefined();
    expect(parsed.signals).toBeDefined();
  });
});
```

**Step 2: Run tests to verify fail**

```bash
npx vitest run tests/llm/swarm-blackboard.test.ts
```
Expected: FAIL — module not found

**Step 3: Implement SwarmBlackboard**

Create `src/llm/swarm-blackboard.ts`:

```typescript
export interface BlackboardMarket {
  pairs: string[];
  regime: string;
  fearGreed: number;
  volumeRatio: number;
  keyLevels?: string[];
}

export interface BlackboardSignals {
  bullish: string[];
  bearish: string[];
  neutral: string[];
}

export interface BlackboardVote {
  d: string;
  c: number;
  prob: number;
  reason: string;
}

export interface BlackboardConflict {
  between: [string, string];
  topic: string;
  severity: 'low' | 'medium' | 'high';
}

export interface BlackboardState {
  market: BlackboardMarket;
  signals: BlackboardSignals;
  votes: Record<string, BlackboardVote>;
  risks: string[];
  conflicts: BlackboardConflict[];
}

export interface PersonaUpdate {
  signals: BlackboardSignals;
  vote: BlackboardVote;
  risks: string[];
  conflicts_with: Record<string, string>;
}

function addUnique(arr: string[], items: string[]): void {
  for (const item of items) {
    if (!arr.includes(item)) arr.push(item);
  }
}

function classifyConflictSeverity(
  voteA: BlackboardVote | undefined,
  voteB: BlackboardVote | undefined,
): 'low' | 'medium' | 'high' {
  if (!voteA || !voteB) return 'low';
  const opposing =
    (voteA.d === 'LONG' && voteB.d === 'SHORT') ||
    (voteA.d === 'SHORT' && voteB.d === 'LONG');
  if (opposing && voteA.c >= 60 && voteB.c >= 60) return 'high';
  if (opposing) return 'medium';
  return 'low';
}

export class SwarmBlackboard {
  private state: BlackboardState;

  constructor(market: BlackboardMarket) {
    this.state = {
      market,
      signals: { bullish: [], bearish: [], neutral: [] },
      votes: {},
      risks: [],
      conflicts: [],
    };
  }

  mergePersonaUpdate(personaCode: string, update: PersonaUpdate): void {
    // Merge signals (deduplicated)
    addUnique(this.state.signals.bullish, update.signals.bullish);
    addUnique(this.state.signals.bearish, update.signals.bearish);
    addUnique(this.state.signals.neutral, update.signals.neutral);

    // Set vote
    this.state.votes[personaCode] = update.vote;

    // Merge risks
    addUnique(this.state.risks, update.risks);

    // Process conflicts
    for (const [targetCode, topic] of Object.entries(update.conflicts_with)) {
      const existing = this.state.conflicts.find(
        c => c.between.includes(personaCode) && c.between.includes(targetCode),
      );
      if (!existing) {
        this.state.conflicts.push({
          between: [personaCode, targetCode],
          topic,
          severity: classifyConflictSeverity(
            this.state.votes[personaCode],
            this.state.votes[targetCode],
          ),
        });
      }
    }
  }

  getState(): BlackboardState {
    return structuredClone(this.state);
  }

  getConflictingSpeakers(): string[] {
    const speakers = new Set<string>();
    for (const c of this.state.conflicts) {
      if (c.severity === 'high' || c.severity === 'medium') {
        speakers.add(c.between[0]);
        speakers.add(c.between[1]);
      }
    }
    return [...speakers];
  }

  toJSON(): string {
    return JSON.stringify(this.state);
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/llm/swarm-blackboard.test.ts
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-blackboard.ts tests/llm/swarm-blackboard.test.ts
git commit -m "feat(swarm): SwarmBlackboard class — shared state with merge logic and conflict detection"
```

---

## Task 3: Blackboard-aware prompts

**Files:**
- Create: `src/llm/blackboard-prompts.ts`
- Test: `tests/llm/blackboard-prompts.test.ts`

**Step 1: Write failing tests**

Create `tests/llm/blackboard-prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildBlackboardExpertPrompt,
  buildBlackboardJudgePrompt,
  BB_PERSONA_CODES,
} from '../../src/llm/blackboard-prompts.js';
import type { BlackboardState } from '../../src/llm/swarm-blackboard.js';

const emptyState: BlackboardState = {
  market: { pairs: ['BTCUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.0 },
  signals: { bullish: [], bearish: [], neutral: [] },
  votes: {},
  risks: [],
  conflicts: [],
};

describe('Blackboard prompts', () => {
  it('expert prompt includes persona role and JSON output format', () => {
    const prompt = buildBlackboardExpertPrompt('risk_manager', emptyState);
    expect(prompt).toContain('RM');
    expect(prompt).toContain('risk');
    expect(prompt).toContain('"signals"');
    expect(prompt).toContain('"vote"');
    expect(prompt).toContain('"conflicts_with"');
    expect(prompt).toContain('BLACKBOARD');
    expect(prompt).toContain('JSON');
  });

  it('expert prompt on round 2 shows existing votes', () => {
    const stateWithVotes: BlackboardState = {
      ...emptyState,
      votes: { BT: { d: 'LONG', c: 70, prob: 65, reason: 'bounce' } },
    };
    const prompt = buildBlackboardExpertPrompt('bear_thesis', stateWithVotes);
    expect(prompt).toContain('BT');
    expect(prompt).toContain('LONG');
  });

  it('judge prompt includes decisions format and continue logic', () => {
    const state: BlackboardState = {
      ...emptyState,
      votes: {
        RM: { d: 'HOLD', c: 90, prob: 30, reason: 'risk' },
        BT: { d: 'LONG', c: 65, prob: 70, reason: 'bounce' },
      },
    };
    const prompt = buildBlackboardJudgePrompt(1, state, 3);
    expect(prompt).toContain('"continue"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"next_speakers"');
    expect(prompt).toContain('BLACKBOARD');
  });

  it('persona codes map correctly', () => {
    expect(BB_PERSONA_CODES.risk_manager).toBe('RM');
    expect(BB_PERSONA_CODES.bull_thesis).toBe('BT');
    expect(BB_PERSONA_CODES.bear_thesis).toBe('BA');
    expect(BB_PERSONA_CODES.market_structure).toBe('MS');
    expect(BB_PERSONA_CODES.devils_advocate).toBe('DA');
    expect(BB_PERSONA_CODES.narrative_expert).toBe('NE');
  });
});
```

**Step 2: Run tests to verify fail**

```bash
npx vitest run tests/llm/blackboard-prompts.test.ts
```

**Step 3: Implement blackboard prompts**

Create `src/llm/blackboard-prompts.ts`:

```typescript
import type { SwarmPersona } from './prompts.js';
import type { BlackboardState } from './swarm-blackboard.js';

export const BB_PERSONA_CODES: Record<string, string> = {
  risk_manager: 'RM',
  bull_thesis: 'BT',
  bear_thesis: 'BA',
  market_structure: 'MS',
  devils_advocate: 'DA',
  narrative_expert: 'NE',
};

const PERSONA_ROLES: Record<string, string> = {
  risk_manager: 'RISK MANAGER: find reasons NOT to trade. Focus: liquidation risk, leverage, drawdown, stop-loss adequacy, position sizing danger.',
  bull_thesis: 'BULL ANALYST: argue the bullish case. Focus: momentum, breakout, support holding, positive catalysts, accumulation signals.',
  bear_thesis: 'BEAR ANALYST: argue the bearish case. Focus: overbought conditions, divergences, resistance, macro headwinds, distribution signals.',
  market_structure: 'MARKET STRUCTURE: microstructure analysis. Focus: funding rates, open interest, long/short ratio, order book imbalance, liquidation zones.',
  devils_advocate: 'DEVILS ADVOCATE: argue OPPOSITE of the emerging consensus. Find: crowded trades, hidden risks, reversal signals, what everyone is missing.',
  narrative_expert: 'NARRATIVE ANALYST: crowd sentiment and positioning. Focus: crypto twitter narrative, influencer calls, sentiment divergence, retail vs smart money.',
};

export function buildBlackboardExpertPrompt(
  persona: SwarmPersona,
  boardState: BlackboardState,
): string {
  const code = BB_PERSONA_CODES[persona] ?? persona.slice(0, 2).toUpperCase();
  const role = PERSONA_ROLES[persona] ?? 'ANALYST';

  return `ROLE: ${role}
CODE: ${code}

BLACKBOARD STATE:
${JSON.stringify(boardState, null, 0)}

Read the blackboard. Analyze the market data provided separately. Write YOUR section update.

OUTPUT (JSON only):
{
  "signals": { "bullish": ["tag1"], "bearish": ["tag2"], "neutral": [] },
  "vote": { "d": "HOLD|LONG|SHORT|CLOSE", "c": <0-100>, "prob": <0-100>, "reason": "<slug>" },
  "risks": ["risk_tag"],
  "conflicts_with": { "<CODE>": "<reason_slug>" }
}

RULES:
- Tags only, no prose. Max 5 words per tag, underscore separated.
- "reason": max 5 words slug explaining your vote.
- "conflicts_with": reference persona CODEs you DISAGREE with and why (slug). Empty {} if no conflict.
- Look at existing votes on the blackboard. If you disagree with someone, add them to conflicts_with.
- NO explanation. NO natural language. ONLY valid JSON.`;
}

export function buildBlackboardJudgePrompt(
  round: number,
  boardState: BlackboardState,
  maxRounds: number = 3,
): string {
  const isLast = round >= maxRounds;
  const voteCount = Object.keys(boardState.votes).length;
  const votes = Object.entries(boardState.votes)
    .map(([code, v]) => `${code}: ${v.d} (conf:${v.c}, prob:${v.prob})`)
    .join(', ');

  return `SWARM JUDGE. Round ${round}/${maxRounds}. ${voteCount} votes cast.

BLACKBOARD STATE:
${JSON.stringify(boardState, null, 0)}

VOTE SUMMARY: ${votes}

CONFLICT COUNT: ${boardState.conflicts.length} (high: ${boardState.conflicts.filter(c => c.severity === 'high').length})

DECISION RULES:
- 3+ same direction AND no high-severity conflicts -> stop, produce final decision
- High-severity conflict exists AND round < ${maxRounds} -> continue, specify who resolves
- Risk Manager flags critical danger AND Devils Advocate agrees -> lean HOLD/CLOSE
- If unclear, lean HOLD
${isLast ? '- THIS IS THE FINAL ROUND. You MUST produce a decision.' : ''}

OUTPUT (JSON only):
{
  "continue": ${isLast ? 'false' : 'true|false'},
  "verdict": "<max_5_word_slug>",
  "next_speakers": ["<CODE>"],
  "decisions": [{"pair": "<PAIR>", "action": "HOLD|LONG|SHORT|CLOSE", "size_pct": <num>, "leverage": <num>, "stop_loss_pct": <num>, "take_profit_pct": <num>, "confidence": <0-100>, "reasoning": "<slug>"}],
  "next_check_minutes": <1-30>
}

RULES:
- continue=true -> decisions=[], next_speakers lists who speaks next
- continue=false -> decisions MUST have entries, next_speakers=[]
- ONLY valid JSON. NO prose.`;
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/llm/blackboard-prompts.test.ts
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/blackboard-prompts.ts tests/llm/blackboard-prompts.test.ts
git commit -m "feat(swarm): blackboard-aware persona + judge prompts"
```

---

## Task 4: Refactor SwarmAgent to use blackboard

**Files:**
- Modify: `src/llm/swarm-agent.ts` (refactor `getConsensus()`)
- Modify: `tests/llm/swarm-agent.test.ts` (update tests)

**Step 1: Read current tests baseline**

```bash
npx vitest run tests/llm/swarm-agent.test.ts
```
Note which tests pass.

**Step 2: Refactor getConsensus() to blackboard loop**

In `src/llm/swarm-agent.ts`, the `getConsensus()` method changes from:
- Level 1-5: all personas write messages → growing conversation history → judge
To:
- Round 1: build blackboard → all personas read board + market data → merge updates → judge
- Round 2 (if conflict): only conflicting personas → merge → judge
- Max 3 rounds

Key changes:
1. Import `SwarmBlackboard` and `buildBlackboardExpertPrompt`, `buildBlackboardJudgePrompt`
2. Replace `conversationHistory` array with `SwarmBlackboard` instance
3. Replace `buildExpertSystemPrompt` calls with `buildBlackboardExpertPrompt`
4. Replace `buildLevelJudgePrompt` calls with `buildBlackboardJudgePrompt`
5. Parse persona responses as `PersonaUpdate` objects and merge into blackboard
6. After Judge: use `bb.getConflictingSpeakers()` for Round 2 speakers
7. Reduce MAX_LEVELS from 5 to 3
8. Store `blackboard_state` in DB via existing `insertLlmConversation`

The method signature and return type (`Promise<TradeDecision[]>`) stay the same.

Preserve: fingerprint dedup, session/cycleId, pendingPersonas DB writes, grok for narrative_expert, sourceHealth tracking.

**Step 3: Update tests**

Update `tests/llm/swarm-agent.test.ts`:
- Mock LLM responses now return `PersonaUpdate` JSON (signals, vote, risks, conflicts_with) instead of `ExpertOutput` JSON
- Judge responses include blackboard-aware format (continue, verdict, decisions, next_speakers)
- Tests for: basic consensus, conflict detection + round 2, max rounds cap, fingerprint dedup still works

**Step 4: Run tests**

```bash
npx vitest run tests/llm/swarm-agent.test.ts
```
Expected: ALL PASS

**Step 5: Verify bot builds**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): refactor SwarmAgent to blackboard pattern — shared state, parallel reads, conflict-only reruns"
```

---

## Task 5: DB migration — conflicts + blackboard_state columns

**Files:**
- Modify: `src/db/types.ts` (update interfaces)
- Modify: `src/db/repository.ts` (update insert functions)

**Step 1: Apply migration via Supabase MCP**

Run SQL:

```sql
ALTER TABLE swarm_personas ADD COLUMN IF NOT EXISTS conflicts_with JSONB;
ALTER TABLE swarm_personas ADD COLUMN IF NOT EXISTS signals JSONB;
ALTER TABLE llm_conversations ADD COLUMN IF NOT EXISTS blackboard_state JSONB;
```

**Step 2: Update DbSwarmPersona interface**

In `src/db/types.ts`, add to `DbSwarmPersona`:

```typescript
export interface DbSwarmPersona {
  // ...existing fields...
  conflicts_with?: Record<string, string>;
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
}
```

**Step 3: Update DbLlmConversation interface**

In `src/db/types.ts`, add to `DbLlmConversation`:

```typescript
export interface DbLlmConversation {
  // ...existing fields...
  blackboard_state?: Record<string, unknown>;
}
```

**Step 4: Update repository insert functions**

In `src/db/repository.ts`, add `conflicts_with`, `signals` to `insertSwarmPersona` INSERT query, and `blackboard_state` to `insertLlmConversation`.

**Step 5: Verify bot builds**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add src/db/types.ts src/db/repository.ts
git commit -m "feat(db): add conflicts_with + signals columns to swarm_personas, blackboard_state to llm_conversations"
```

---

## Task 6: ConflictCard component

**Files:**
- Create: `dashboard/src/components/swarm/ConflictCard.tsx`

**Step 1: Create ConflictCard**

```tsx
import { motion } from 'framer-motion';

interface ConflictCardProps {
  personaA: string;
  personaB: string;
  topic: string;
  severity: 'low' | 'medium' | 'high';
}

const PERSONA_EMOJI: Record<string, string> = {
  BT: '🐂', BA: '🐻', RM: '🛡️', MS: '🔬', DA: '😈', NE: '📰',
  bull_thesis: '🐂', bear_thesis: '🐻', risk_manager: '🛡️',
  market_structure: '🔬', devils_advocate: '😈', narrative_expert: '📰',
};

const SEVERITY_COLORS: Record<string, { border: string; bg: string; bar: string }> = {
  low: { border: 'border-zinc-600', bg: 'bg-zinc-800/50', bar: 'bg-zinc-500' },
  medium: { border: 'border-yellow-700', bg: 'bg-yellow-950/30', bar: 'bg-yellow-500' },
  high: { border: 'border-amber-500', bg: 'bg-amber-950/30', bar: 'bg-amber-500' },
};

export function ConflictCard({ personaA, personaB, topic, severity }: ConflictCardProps) {
  const colors = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.low;
  const emojiA = PERSONA_EMOJI[personaA] ?? '🤖';
  const emojiB = PERSONA_EMOJI[personaB] ?? '🤖';
  const barWidth = severity === 'high' ? '100%' : severity === 'medium' ? '60%' : '30%';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className={`mx-auto max-w-sm rounded-lg border ${colors.border} ${colors.bg} px-4 py-3`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Conflict
        </span>
        <span className="text-sm">
          {emojiA} vs {emojiB}
        </span>
      </div>
      <p className="text-xs text-zinc-400 mb-2">
        {topic.replace(/_/g, ' ')}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 w-14">{severity}</span>
        <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: barWidth }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className={`h-full rounded-full ${colors.bar}`}
          />
        </div>
      </div>
      {severity === 'high' && (
        <motion.div
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="absolute inset-0 rounded-lg border border-amber-500/30 pointer-events-none"
        />
      )}
    </motion.div>
  );
}
```

**Step 2: Verify dashboard builds**

```bash
cd dashboard && npm run build
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/ConflictCard.tsx
git commit -m "feat(dashboard): ConflictCard component with severity animation"
```

---

## Task 7: BlackboardStateCard component

**Files:**
- Create: `dashboard/src/components/swarm/BlackboardStateCard.tsx`

**Step 1: Create BlackboardStateCard**

```tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface BlackboardStateCardProps {
  signals: { bullish: string[]; bearish: string[]; neutral: string[] };
  votes: Record<string, { d: string; c: number; prob: number; reason: string }>;
  risks: string[];
  conflicts: Array<{ between: string[]; topic: string; severity: string }>;
}

const VOTE_DOT: Record<string, string> = {
  LONG: 'bg-green-400',
  SHORT: 'bg-red-400',
  HOLD: 'bg-zinc-500',
  CLOSE: 'bg-yellow-400',
};

function TagPill({ tag, color }: { tag: string; color: string }) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`inline-block text-xs px-2 py-0.5 rounded-full ${color} mr-1 mb-1`}
    >
      {tag.replace(/_/g, ' ')}
    </motion.span>
  );
}

export function BlackboardStateCard({ signals, votes, risks, conflicts }: BlackboardStateCardProps) {
  const [open, setOpen] = useState(false);

  const voteEntries = Object.entries(votes);
  const majorityVote = (() => {
    const counts: Record<string, number> = {};
    for (const [, v] of voteEntries) {
      counts[v.d] = (counts[v.d] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  })();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mx-4 my-2 rounded-lg border border-zinc-700 bg-zinc-900/80 overflow-hidden"
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-zinc-800/50 transition-colors"
      >
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Blackboard State
        </span>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {voteEntries.map(([code, v]) => (
              <div
                key={code}
                className={`w-2.5 h-2.5 rounded-full ${VOTE_DOT[v.d] ?? 'bg-zinc-500'}`}
                title={`${code}: ${v.d}`}
              />
            ))}
          </div>
          {majorityVote && (
            <span className="text-xs text-zinc-500">
              {majorityVote[1]}/{voteEntries.length} {majorityVote[0]}
            </span>
          )}
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="text-zinc-500 text-xs"
          >
            ▼
          </motion.span>
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-3 border-t border-zinc-800">
              {/* Signals */}
              <div className="pt-3">
                {signals.bullish.length > 0 && (
                  <div className="mb-1">
                    <span className="text-xs text-zinc-500 mr-2">Bullish</span>
                    {signals.bullish.map(t => (
                      <TagPill key={t} tag={t} color="bg-green-900/50 text-green-300" />
                    ))}
                  </div>
                )}
                {signals.bearish.length > 0 && (
                  <div className="mb-1">
                    <span className="text-xs text-zinc-500 mr-2">Bearish</span>
                    {signals.bearish.map(t => (
                      <TagPill key={t} tag={t} color="bg-red-900/50 text-red-300" />
                    ))}
                  </div>
                )}
                {risks.length > 0 && (
                  <div className="mb-1">
                    <span className="text-xs text-zinc-500 mr-2">Risks</span>
                    {risks.map(t => (
                      <TagPill key={t} tag={t} color="bg-yellow-900/50 text-yellow-300" />
                    ))}
                  </div>
                )}
              </div>

              {/* Votes */}
              <div className="flex flex-wrap gap-3">
                {voteEntries.map(([code, v]) => (
                  <div key={code} className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${VOTE_DOT[v.d] ?? 'bg-zinc-500'}`} />
                    <span className="text-xs font-mono text-zinc-400">{code}</span>
                    <span className="text-xs text-zinc-600">{v.d} {v.c}%</span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
```

**Step 2: Verify dashboard builds**

```bash
cd dashboard && npm run build
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/BlackboardStateCard.tsx
git commit -m "feat(dashboard): BlackboardStateCard — collapsible state summary with tag pills and vote dots"
```

---

## Task 8: Wire ConflictCard + BlackboardStateCard into Swarm.tsx

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx`

**Step 1: Add imports**

```tsx
import { ConflictCard } from '../components/swarm/ConflictCard';
import { BlackboardStateCard } from '../components/swarm/BlackboardStateCard';
```

**Step 2: Fetch blackboard state data**

Add to the Supabase query in the `load` function — when fetching `llm_conversations` for a cycle, also retrieve `blackboard_state`:

```tsx
// In the judges query, add blackboard_state to select
const judgeConvsRes = await supabase
  .from('llm_conversations')
  .select('raw_response, created_at, label, blackboard_state')
  .eq('cycle_id', j.cycle_id)
  .eq('method', 'swarm_consensus')
  .order('created_at', { ascending: true });
```

Also fetch conflicts from swarm_personas:

```tsx
const personasRes = await supabase
  .from('swarm_personas')
  .select('persona, vote, confidence, reasoning, created_at, phase, reply_to_id, conflicts_with, signals')
  .gte('created_at', windowStart)
  .lte('created_at', windowEnd)
  .order('created_at', { ascending: true });
```

**Step 3: Add blackboard state + conflicts to DebateData**

```typescript
interface DebateData {
  // ...existing...
  blackboardStates: Array<{ phase: number; state: any }>;
  conflicts: Array<{ personaA: string; personaB: string; topic: string; severity: string; phase: number }>;
}
```

Build conflicts from persona data:

```typescript
const conflicts: DebateData['conflicts'] = [];
for (const p of personaList) {
  if (p.conflicts_with && typeof p.conflicts_with === 'object') {
    for (const [target, topic] of Object.entries(p.conflicts_with as Record<string, string>)) {
      conflicts.push({
        personaA: p.persona,
        personaB: target,
        topic,
        severity: 'medium', // computed client-side or from board state
        phase: p.phase ?? 1,
      });
    }
  }
}
```

Build blackboard states from judge conversations:

```typescript
const blackboardStates: DebateData['blackboardStates'] = [];
for (const [level, convs] of judgeByLevel) {
  for (const jc of convs) {
    if (jc.blackboard_state) {
      blackboardStates.push({ phase: level, state: jc.blackboard_state });
    }
  }
}
```

**Step 4: Render ConflictCard and BlackboardStateCard in renderMessages**

In the `renderMessages` function, after each level's persona messages and before judge:

```tsx
// After persona messages for this phase, render conflicts
const phaseConflicts = current.conflicts.filter(c => c.phase === phase);
for (const c of phaseConflicts) {
  elements.push(
    <ConflictCard
      key={`conflict-${c.personaA}-${c.personaB}-${phase}`}
      personaA={c.personaA}
      personaB={c.personaB}
      topic={c.topic}
      severity={c.severity as 'low' | 'medium' | 'high'}
    />,
  );
}

// After judge verdict, render blackboard state card
const phaseBoard = current.blackboardStates.find(b => b.phase === phase);
if (phaseBoard?.state) {
  elements.push(
    <BlackboardStateCard
      key={`board-${phase}`}
      signals={phaseBoard.state.signals ?? { bullish: [], bearish: [], neutral: [] }}
      votes={phaseBoard.state.votes ?? {}}
      risks={phaseBoard.state.risks ?? []}
      conflicts={phaseBoard.state.conflicts ?? []}
    />,
  );
}
```

**Step 5: Verify dashboard builds**

```bash
cd dashboard && npm run build
```

**Step 6: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): wire ConflictCard + BlackboardStateCard into swarm chat"
```

---

## Task Summary

| Task | What | Domain | Effort |
|------|------|--------|--------|
| 1 | framer-motion + animate existing chat messages | Frontend | Small |
| 2 | SwarmBlackboard class + merge + conflict detection | Backend | Medium |
| 3 | Blackboard-aware persona + judge prompts | Backend | Medium |
| 4 | Refactor SwarmAgent to blackboard loop | Backend | Large |
| 5 | DB migration: conflicts, signals, blackboard_state | Backend/DB | Small |
| 6 | ConflictCard component (animated) | Frontend | Small |
| 7 | BlackboardStateCard component (collapsible) | Frontend | Medium |
| 8 | Wire new components into Swarm.tsx | Frontend | Small |

**Backend tasks (2-5) are independent of frontend tasks (1, 6-8).** Can be parallelized.

**LLM calls per cycle (Blackboard):**
- Round 1: 3-4 personas (parallel) + 1 judge = 4-5 calls
- Round 2 (only if conflict): 2 personas + 1 judge = 3 calls
- Total: 4-8 calls (was 6-17 with old sequential)
