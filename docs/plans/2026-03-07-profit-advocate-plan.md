# Profit Advocate (DA) Reactive Grok Persona — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make DA a reactive persona that activates after round 1 voting, uses Grok search for real arguments, and acts as an aggressive trader who always pushes for action.

**Architecture:** DA removed from parallel round 1 call. After round 1 `Promise.allSettled([RM, MS, NE])`, votes are checked via `shouldActivateDA()`. If activated, DA runs via Grok with `{ search: true }` (X + web), sees all round 1 votes on blackboard, and writes its update before judge.

**Tech Stack:** TypeScript ESM, Vitest, Grok `/v1/responses` API with `web_search` + `x_search` tools

---

### Task 1: Add `shouldActivateDA()` function with tests

**Files:**
- Create: `src/llm/da-activation.ts`
- Create: `tests/llm/da-activation.test.ts`

**Step 1: Write the failing tests**

In `tests/llm/da-activation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldActivateDA } from '../../src/llm/da-activation.js';
import type { BlackboardVote } from '../../src/llm/swarm-blackboard.js';

const vote = (d: string, c = 70, prob = 60): BlackboardVote => ({ d, c, prob, reason: 'test' });

describe('shouldActivateDA', () => {
  it('activates when exactly 1 action vote (LONG)', () => {
    const votes = { RM: vote('HOLD'), MS: vote('HOLD'), NE: vote('LONG') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('activates when exactly 1 action vote (SHORT)', () => {
    const votes = { RM: vote('HOLD'), MS: vote('SHORT'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('activates when CLOSE without action', () => {
    const votes = { RM: vote('CLOSE'), MS: vote('HOLD'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('activates when CLOSE + action', () => {
    const votes = { RM: vote('CLOSE'), MS: vote('LONG'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('skips when all HOLD', () => {
    const votes = { RM: vote('HOLD'), MS: vote('HOLD'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(false);
  });

  it('skips when 2+ actions', () => {
    const votes = { RM: vote('LONG'), MS: vote('LONG'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(false);
  });

  it('skips when empty votes', () => {
    expect(shouldActivateDA({})).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm/da-activation.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `shouldActivateDA`**

In `src/llm/da-activation.ts`:

```ts
import type { BlackboardVote } from './swarm-blackboard.js';

export function shouldActivateDA(votes: Record<string, BlackboardVote>): boolean {
  const dirs = Object.values(votes).map(v => v.d);
  const actionCount = dirs.filter(d => d === 'LONG' || d === 'SHORT').length;
  const closeCount = dirs.filter(d => d === 'CLOSE').length;

  if (actionCount === 1) return true;
  if (closeCount > 0 && actionCount <= 1) return true;
  return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/llm/da-activation.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/da-activation.ts tests/llm/da-activation.test.ts
git commit -m "feat(swarm): shouldActivateDA activation logic with tests"
```

---

### Task 2: Add `buildDAPrompt()` in blackboard-prompts.ts

**Files:**
- Modify: `src/llm/blackboard-prompts.ts:25-38` (PERSONA_ROLES) and add new function
- Modify: `tests/llm/blackboard-prompts.test.ts`

**Step 1: Write the failing test**

Add to `tests/llm/blackboard-prompts.test.ts`:

```ts
import { buildDAPrompt } from '../../src/llm/blackboard-prompts.js';

describe('buildDAPrompt', () => {
  it('includes other votes and aggressive tone', () => {
    const boardState = {
      market: { pairs: ['ETHUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.2 },
      signals: { bullish: ['ema_bounce'], bearish: [], neutral: [] },
      votes: {
        RM: { d: 'HOLD', c: 70, prob: 40, reason: 'too risky' },
        MS: { d: 'LONG', c: 65, prob: 55, reason: 'breakout forming' },
      },
      risks: ['liq_cascade'],
      conflicts: [],
    };

    const prompt = buildDAPrompt(boardState);
    expect(prompt).toContain('PROFIT ADVOCATE');
    expect(prompt).toContain('NEVER vote HOLD');
    expect(prompt).toContain('RM: HOLD');
    expect(prompt).toContain('MS: LONG');
    expect(prompt).toContain('ETHUSDT');
  });

  it('includes CLOSE counter-argument instruction when CLOSE vote exists', () => {
    const boardState = {
      market: { pairs: ['BTCUSDT'], regime: 'BullTrend', fearGreed: 60, volumeRatio: 1.5 },
      signals: { bullish: [], bearish: ['breakdown'], neutral: [] },
      votes: {
        RM: { d: 'CLOSE', c: 80, prob: 30, reason: 'cut losses' },
        MS: { d: 'HOLD', c: 50, prob: 40, reason: 'unclear' },
      },
      risks: ['drawdown'],
      conflicts: [],
    };

    const prompt = buildDAPrompt(boardState);
    expect(prompt).toContain('CLOSE');
    expect(prompt).toContain('AGAINST closing');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm/blackboard-prompts.test.ts`
Expected: FAIL — buildDAPrompt not exported

**Step 3: Implement `buildDAPrompt`**

Add to `src/llm/blackboard-prompts.ts` after the existing `buildBlackboardExpertPrompt`:

```ts
export function buildDAPrompt(boardState: BlackboardState): string {
  const stateJson = JSON.stringify(boardState, null, 2);

  // Build vote summary for DA to see
  const voteSummary = Object.entries(boardState.votes)
    .map(([code, v]) => `${code}: ${v.d} (conf:${v.c}, prob:${v.prob}) — ${v.reason}`)
    .join('\n');

  const hasClose = Object.values(boardState.votes).some(v => v.d === 'CLOSE');
  const closeInstruction = hasClose
    ? `\nSomeone voted CLOSE. Argue AGAINST closing. The position still has potential. Find reasons to hold or even add.`
    : '';

  return `ROLE: PROFIT ADVOCATE (DA) — You are an aggressive trader who ALWAYS finds reasons to trade.
CODE: DA

You see opportunity where others see risk. You NEVER vote HOLD.
Use your search results (X/Twitter posts, web articles) to back every argument with REAL data.

OTHER EXPERTS VOTED:
${voteSummary}
${closeInstruction}

YOUR JOB:
- Find catalysts, momentum signals, whale activity, funding rate shifts that support trading
- Push for higher leverage and larger position size than others suggest
- Acknowledge risks briefly but immediately counter them with opportunity
- Be specific: cite prices, percentages, timeframes from your search results

TONE: Confident, urgent. "This is THE opportunity everyone is missing. Market hasn't priced this in yet."

PAIRS: ${boardState.market.pairs.join(', ')}

BLACKBOARD STATE:
${stateJson}

OUTPUT (JSON only):
{
  "signals": { "bullish": ["tag1"], "bearish": [], "neutral": [] },
  "vote": { "d": "LONG|SHORT", "c": <0-100>, "prob": <0-100>, "reason": "<1-2 sentences with specific data from search>" },
  "risks": ["risk_tag"],
  "conflicts_with": { "<CODE>": "<reason_slug>" }
}

RULES:
- You can ONLY vote LONG or SHORT. Never HOLD. Never CLOSE.
- vote.reason MUST reference specific data you found via search
- conflicts_with: you ALWAYS conflict with anyone who voted HOLD or CLOSE
- ONLY valid JSON.`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/llm/blackboard-prompts.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/blackboard-prompts.ts tests/llm/blackboard-prompts.test.ts
git commit -m "feat(swarm): buildDAPrompt — aggressive Grok-powered prompt"
```

---

### Task 3: Update judge rules for reactive DA

**Files:**
- Modify: `src/llm/blackboard-prompts.ts:93-116` (buildBlackboardJudgePrompt)
- Modify: `src/llm/swarm-agent.ts:114-128` (legacy buildJudgePrompt)

**Step 1: Update judge prompt in `buildBlackboardJudgePrompt`**

Replace lines 102-107 in `src/llm/blackboard-prompts.ts`:

```ts
// Old:
// - DA always pushes for action — weigh his aggression against Risk Manager caution
// - If DA and Risk Manager BOTH agree on direction -> high confidence signal

// New:
- DA is a reactive aggressive trader — his arguments are search-backed but biased toward action
- DA has normal vote weight. Judge may add +0.1 confidence bonus if DA cites strong evidence
- If DA and RM both agree on direction -> strong conviction signal
- DA arguments against CLOSE should be weighed against RM caution — not auto-accepted
```

**Step 2: Update legacy `buildJudgePrompt` in `swarm-agent.ts`**

Replace line 118 and 125:

```ts
// Line 118 — old: "The Devil's Advocate's job is to find flaws"
// New:
'The Profit Advocate (DA) always pushes for action — his arguments are search-backed. Weigh DA aggression against Risk Manager caution.'

// Line 125 — old: "If the Risk Manager flags critical danger AND the Devil's Advocate agrees"
// New:
'If the Risk Manager flags critical danger, lean towards CLOSE or HOLD regardless of DA.'
```

**Step 3: Run existing tests**

Run: `npx vitest run tests/llm/blackboard-prompts.test.ts tests/llm/swarm-agent.test.ts`
Expected: ALL PASS (no behavioral change, only prompt text)

**Step 4: Commit**

```bash
git add src/llm/blackboard-prompts.ts src/llm/swarm-agent.ts
git commit -m "feat(swarm): update judge rules for reactive DA"
```

---

### Task 4: Wire reactive DA into SwarmAgent.getConsensus()

**Files:**
- Modify: `src/llm/swarm-agent.ts:186-220` (getConsensus method)

**Step 1: Write the failing test**

Add to `tests/llm/swarm-agent.test.ts`:

```ts
it('DA activates reactively when 1 action vote (not in round 1 parallel)', async () => {
  let codexCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      codexCount++;
      // Round 1: RM(HOLD), MS(LONG) — 2 codex experts
      if (codexCount === 1) return Promise.resolve(makePersonaUpdate('HOLD', 70, 40)); // RM
      if (codexCount === 2) return Promise.resolve(makePersonaUpdate('LONG', 65, 55)); // MS
      // Judge call (after DA)
      return Promise.resolve(makeJudgeResponse(false));
    }),
    lastNextCheckMinutes: undefined,
  } as any;
  const mockGrok = {
    call: vi.fn().mockResolvedValue(makePersonaUpdate('LONG', 80, 70)), // DA via Grok
  } as any;

  const agent = new SwarmAgent(mockLlm, mockGrok);
  const decisions = await agent.getConsensus(makeMinimalPromptData());

  // Round 1: 2 codex (RM, MS) + 1 grok (NE) parallel → DA activates → 1 grok (DA) → judge = 3 codex + 2 grok
  expect(mockLlm.call).toHaveBeenCalledTimes(3); // RM + MS + judge
  expect(mockGrok.call).toHaveBeenCalledTimes(2); // NE + DA
  expect(decisions).toHaveLength(1);
});

it('DA does NOT activate when all HOLD', async () => {
  let codexCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      codexCount++;
      if (codexCount <= 2) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
      return Promise.resolve(makeJudgeResponse(false));
    }),
    lastNextCheckMinutes: undefined,
  } as any;
  const mockGrok = {
    call: vi.fn().mockResolvedValue(makePersonaUpdate('HOLD', 50, 30)), // NE
  } as any;

  const agent = new SwarmAgent(mockLlm, mockGrok);
  await agent.getConsensus(makeMinimalPromptData());

  // RM + MS codex, NE grok, judge codex — NO DA
  expect(mockLlm.call).toHaveBeenCalledTimes(3); // RM + MS + judge
  expect(mockGrok.call).toHaveBeenCalledTimes(1); // NE only, no DA
});

it('DA does NOT activate when 2+ action votes', async () => {
  let codexCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      codexCount++;
      if (codexCount === 1) return Promise.resolve(makePersonaUpdate('LONG', 70, 60)); // RM
      if (codexCount === 2) return Promise.resolve(makePersonaUpdate('LONG', 65, 55)); // MS
      return Promise.resolve(makeJudgeResponse(false));
    }),
    lastNextCheckMinutes: undefined,
  } as any;
  const mockGrok = {
    call: vi.fn().mockResolvedValue(makePersonaUpdate('HOLD', 50, 30)),
  } as any;

  const agent = new SwarmAgent(mockLlm, mockGrok);
  await agent.getConsensus(makeMinimalPromptData());

  expect(mockGrok.call).toHaveBeenCalledTimes(1); // NE only, no DA
});

it('DA works without Grok (no grokLlm) — uses codex fallback', async () => {
  let codexCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      codexCount++;
      if (codexCount === 1) return Promise.resolve(makePersonaUpdate('HOLD', 70, 40)); // RM
      if (codexCount === 2) return Promise.resolve(makePersonaUpdate('SHORT', 65, 55)); // MS
      // DA via codex (no grok available)
      if (codexCount === 3) return Promise.resolve(makePersonaUpdate('SHORT', 75, 65)); // DA
      return Promise.resolve(makeJudgeResponse(false));
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm); // no grokLlm
  const decisions = await agent.getConsensus(makeMinimalPromptData());

  // RM + MS + DA + judge = 4 codex calls
  expect(mockLlm.call).toHaveBeenCalledTimes(4);
  expect(decisions).toHaveLength(1);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: FAIL — call counts don't match old behavior

**Step 3: Implement reactive DA in `getConsensus()`**

Modify `src/llm/swarm-agent.ts`:

1. Change `allPersonas` (line 189): remove `'devils_advocate'`
```ts
const allPersonas: SwarmPersona[] = ['risk_manager', 'market_structure'];
if (this.grokLlm) allPersonas.push('narrative_expert');
```

2. After round 1 `Promise.allSettled` results are processed and merged into blackboard (after the `for` loop at ~line 278), add DA activation before judge:

```ts
// ── Reactive DA activation (round 1 only) ──
if (round === 1) {
  const { shouldActivateDA } = await import('./da-activation.js');
  if (shouldActivateDA(bb.getState().votes)) {
    console.log('[Swarm] DA activated — searching for arguments via Grok');
    const { buildDAPrompt } = await import('./blackboard-prompts.js');
    const daPrompt = buildDAPrompt(bb.getState());
    try {
      const daRaw = this.grokLlm
        ? await this.grokLlm.call(daPrompt, userPrompt, 'grok-4-1-fast-non-reasoning', { search: true })
        : await this.llm.call(daPrompt, userPrompt);
      const daUpdate = parsePersonaUpdate(daRaw);
      if (daUpdate?.vote) {
        bb.mergePersonaUpdate('DA', daUpdate);
        conversationHistory.push({ persona: 'devils_advocate', content: daRaw.slice(0, 500), vote: daUpdate.vote.d, phase: round });
        if (this.sessionId) {
          levelPending.push({
            persona: 'devils_advocate', model: this.grokLlm ? 'grok' : 'codex',
            raw_response: daRaw, vote: daUpdate.vote.d, confidence: daUpdate.vote.c,
            reasoning: daUpdate.vote.reason || daRaw.slice(0, 500), phase: round,
            conflicts_with: daUpdate.conflicts_with, signals: daUpdate.signals,
          });
        }
      }
      this.sourceHealth?.recordSuccess('grok-da');
    } catch (e: any) {
      console.warn('[Swarm] DA failed:', e.message);
      this.sourceHealth?.recordFailure('grok-da', e.message ?? String(e));
    }
  } else {
    console.log('[Swarm] DA skipped — activation condition not met');
  }
}
```

**Step 4: Update existing tests**

Several existing tests assume 3 experts in round 1. Update call count expectations:
- "basic consensus: all agree HOLD" — now 2 codex (RM, MS) + judge = 3 (no DA, no grok)
- "conflict triggers round 2" — update counts
- Other tests: adjust `callCount` thresholds

**Step 5: Run all swarm tests**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): reactive DA — activates after round 1 votes via Grok search"
```

---

### Task 5: Update existing tests for new call counts

**Files:**
- Modify: `tests/llm/swarm-agent.test.ts`

**Step 1: Fix all existing test call count expectations**

Without grokLlm (most existing tests): round 1 has 2 experts (RM, MS), no NE, no DA.

| Test | Old call count | New call count | Reason |
|------|---------------|----------------|--------|
| basic consensus (all HOLD) | 4 (3+judge) | 3 (2+judge) | No DA, no grok |
| conflict round 2 | 7 | 6 | 2+judge+2+judge |
| conflict-based round 2 | 7 | 6 | Same |
| caps MAX_ROUNDS | 10 | 8 | 2+j+2+j+2+j |
| fingerprint dedup | 4 then 4 | 3 then 3 | |
| new debate on fp change | 4 then 4 | 3 then 3 | |
| TTL expiry | 4 then 4 | 3 then 3 | |
| with Grok | 4 codex + 1 grok | 3 codex + 1 grok | NE only |
| judge throws | 4 | 3 | |
| next_check_minutes | 4 | 3 | |
| TradeDecision format | 4 | 3 | |

Tests with grokLlm + action votes: DA will activate via grok (additional grok call).

**Step 2: Run all tests**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: ALL PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/llm/swarm-agent.test.ts
git commit -m "test(swarm): update call counts for reactive DA architecture"
```

---

### Task 6: Integration smoke test

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Check TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit all remaining changes**

If any uncommitted files remain:
```bash
git add -A && git commit -m "chore: cleanup after DA reactive refactor"
```
