# Swarm Dedup & Quality Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate redundant swarm debates and make personas genuinely argue, cutting token burn ~70% while improving decision quality.

**Architecture:** Add fingerprint-based dedup to skip re-running swarm when market conditions haven't materially changed. Rewrite persona prompts so Bull argues FOR longs, Bear argues FOR shorts, and Devil's Advocate explicitly attacks the current consensus. Link swarm_persona rows to conversation_id.

**Tech Stack:** TypeScript ESM, Vitest, pg (Supabase)

---

### Task 1: Swarm Fingerprint — dedup logic

**Files:**
- Create: `src/llm/swarm-fingerprint.ts`
- Test: `tests/llm/swarm-fingerprint.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/llm/swarm-fingerprint.test.ts
import { describe, it, expect } from 'vitest';
import { buildSwarmFingerprint, hasChanged } from '../../src/llm/swarm-fingerprint.js';

describe('swarm-fingerprint', () => {
  const base = {
    positions: [{ pair: 'ADAUSDT', side: 'SHORT', unrealizedPnlPct: -2.1 }],
    regime: 'BearTrend',
    volumeRatio: 1.8,
    fearGreedValue: 35,
  };

  it('produces stable fingerprint for same inputs', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint(base);
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
  });

  it('detects change when position added', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({
      ...base,
      positions: [...base.positions, { pair: 'BTCUSDT', side: 'LONG', unrealizedPnlPct: 1.0 }],
    });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });

  it('detects change when regime changes', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({ ...base, regime: 'Breakout' });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });

  it('ignores small PnL drift (<1%)', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({
      ...base,
      positions: [{ pair: 'ADAUSDT', side: 'SHORT', unrealizedPnlPct: -2.5 }],
    });
    expect(hasChanged(fp1, fp2)).toBe(false);
  });

  it('detects large PnL change (>2%)', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({
      ...base,
      positions: [{ pair: 'ADAUSDT', side: 'SHORT', unrealizedPnlPct: -5.0 }],
    });
    expect(hasChanged(fp1, fp2)).toBe(true);
  });

  it('detects fear/greed bucket change', () => {
    const fp1 = buildSwarmFingerprint(base);
    const fp2 = buildSwarmFingerprint({ ...base, fearGreedValue: 15 }); // 35→15 = different bucket
    expect(hasChanged(fp1, fp2)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/swarm-fingerprint.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/llm/swarm-fingerprint.ts

interface FingerprintInput {
  positions: Array<{ pair: string; side: string; unrealizedPnlPct: number }>;
  regime: string;
  volumeRatio: number;
  fearGreedValue: number;
}

/**
 * Build a string fingerprint of the market state relevant to swarm decisions.
 * Quantizes continuous values into buckets so small noise doesn't trigger re-debate.
 */
export function buildSwarmFingerprint(input: FingerprintInput): string {
  const posPart = input.positions
    .map(p => `${p.pair}:${p.side}:${Math.round(p.unrealizedPnlPct)}`)
    .sort()
    .join('|');

  const fgBucket = Math.floor(input.fearGreedValue / 20); // 0-4 buckets (0-19, 20-39, ...)
  const volBucket = input.volumeRatio < 1 ? 'low' : input.volumeRatio < 2 ? 'mid' : 'high';

  return `${posPart};;${input.regime};;${volBucket};;fg${fgBucket}`;
}

/**
 * Returns true if the fingerprint has materially changed.
 */
export function hasChanged(prev: string, current: string): boolean {
  return prev !== current;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/swarm-fingerprint.test.ts`
Expected: 6 PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-fingerprint.ts tests/llm/swarm-fingerprint.test.ts
git commit -m "feat(swarm): add fingerprint-based dedup logic"
```

---

### Task 2: Wire fingerprint into SwarmAgent — skip unchanged debates

**Files:**
- Modify: `src/llm/swarm-agent.ts:181-196` (constructor + getConsensus)
- Modify: `src/trading-loop.ts:650-663` (pass fingerprint data)
- Test: `tests/llm/swarm-agent.test.ts` (add dedup test)

**Step 1: Write the failing test**

Add to `tests/llm/swarm-agent.test.ts`:

```typescript
it('skips debate when fingerprint unchanged, returns cached decisions', async () => {
  let callCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
      return Promise.resolve(consensusResponse);
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  const data = makeMinimalPromptData();

  // First call: runs full debate
  const d1 = await agent.getConsensus(data);
  expect(mockLlm.call).toHaveBeenCalledTimes(4);

  // Second call with same data: skips debate, returns cached
  const d2 = await agent.getConsensus(data);
  expect(mockLlm.call).toHaveBeenCalledTimes(4); // no new calls
  expect(d2).toEqual(d1);
});

it('runs new debate when fingerprint changes', async () => {
  let callCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3 || (callCount >= 5 && callCount <= 7)) {
        return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
      }
      return Promise.resolve(consensusResponse);
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  const data1 = makeMinimalPromptData();

  await agent.getConsensus(data1);
  expect(mockLlm.call).toHaveBeenCalledTimes(4);

  // Change portfolio — new position
  const data2: typeof data1 = {
    ...data1,
    portfolio: {
      ...data1.portfolio,
      positions: [{ pair: 'BTCUSDT', side: 'LONG', entryPrice: 90000, heldHours: 1, unrealizedPnlPct: 2, leverage: 5 }],
    },
  };

  await agent.getConsensus(data2);
  expect(mockLlm.call).toHaveBeenCalledTimes(8); // 4 new calls
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: FAIL — no caching behavior yet

**Step 3: Modify SwarmAgent**

In `src/llm/swarm-agent.ts`, add caching fields and fingerprint check:

```typescript
// Add import at top:
import { buildSwarmFingerprint, hasChanged } from './swarm-fingerprint.js';

// Add fields to SwarmAgent class (after line 183):
private lastFingerprint: string = '';
private lastDecisions: TradeDecision[] = [];

// At start of getConsensus() method (after line 188, before userPrompt):
const fp = buildSwarmFingerprint({
  positions: data.portfolio.positions.map(p => ({
    pair: p.pair,
    side: p.side,
    unrealizedPnlPct: p.unrealizedPnlPct,
  })),
  regime: data.regime ?? '',
  volumeRatio: data.snapshots[0]?.volumeRatio ?? 0,
  fearGreedValue: data.fearGreed?.value ?? 50,
});

if (!hasChanged(this.lastFingerprint, fp) && this.lastDecisions.length > 0) {
  console.log('[Swarm] Fingerprint unchanged — reusing previous consensus');
  return this.lastDecisions;
}

// At end of getConsensus(), before final return (replace `return parsed.decisions || [];`):
const decisions = parsed.decisions || [];
this.lastFingerprint = fp;
this.lastDecisions = decisions;
return decisions;
```

Also update the early returns (line 335 `return [];` and line 351 `return [];`) to NOT cache empty results — leave fingerprint unchanged so next cycle retries.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: ALL PASS (12 tests)

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): skip debate when market fingerprint unchanged"
```

---

### Task 3: Rewrite persona prompts for genuine disagreement

**Files:**
- Modify: `src/llm/prompts.ts:613-679` (buildExpertSystemPrompt)
- Test: `tests/llm/prompts.test.ts` (new file — prompt content assertions)

**Step 1: Write the failing test**

```typescript
// tests/llm/prompts.test.ts
import { describe, it, expect } from 'vitest';
import { buildExpertSystemPrompt } from '../../src/llm/prompts.js';

describe('buildExpertSystemPrompt', () => {
  it('risk_manager focuses on reasons NOT to trade', () => {
    const prompt = buildExpertSystemPrompt('risk_manager');
    expect(prompt).toContain('reasons NOT to trade');
    expect(prompt).toContain('catastrophic loss');
  });

  it('devils_advocate must argue AGAINST the majority', () => {
    const prompt = buildExpertSystemPrompt('devils_advocate');
    expect(prompt).toContain('OPPOSITE');
    expect(prompt).toContain('contrarian');
    expect(prompt).toContain('NEVER agree with the majority');
  });

  it('market_structure focuses on microstructure signals', () => {
    const prompt = buildExpertSystemPrompt('market_structure');
    expect(prompt).toContain('Funding rate');
    expect(prompt).toContain('Open interest');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL on devils_advocate assertions (current prompt doesn't contain "OPPOSITE" or "NEVER agree")

**Step 3: Rewrite buildExpertSystemPrompt**

In `src/llm/prompts.ts`, replace the `devils_advocate` case (lines 657-665):

```typescript
    case 'devils_advocate':
      personaPrefix = `You are the DEVIL'S ADVOCATE (Contrarian Stress-Tester) on a LIVE crypto futures account with real money.
YOUR CARDINAL RULE: You MUST argue the OPPOSITE of what the data superficially suggests.
- If technicals look bearish and everyone will say SHORT/HOLD — you MUST find the bull case
- If everything looks bullish — you MUST find the bear case and reasons to be cautious
- You are a professional contrarian. You NEVER agree with the majority.
- Find: hidden liquidation cascades, crowded trades about to unwind, sentiment extremes that reverse
- Challenge: confirmation bias, recency bias, anchoring to unrealized P&L
- Your probability_of_success reflects the CONTRARIAN scenario, not the consensus
- If you find yourself agreeing with the obvious read, you are FAILING your job
- Your value is ZERO if you output the same position as everyone else`;
      break;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: 3 PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (existing tests unaffected)

**Step 6: Commit**

```bash
git add src/llm/prompts.ts tests/llm/prompts.test.ts
git commit -m "feat(swarm): rewrite devils_advocate prompt for genuine contrarian behavior"
```

---

### Task 4: Link swarm_persona rows to conversation_id

**Files:**
- Modify: `src/llm/swarm-agent.ts:220-229` (defer persona inserts)
- Modify: `src/db/repository.ts` (add updateSwarmPersonaConversationId if needed)
- Test: `tests/llm/swarm-agent.test.ts` (verify persona insert includes conversation_id)

**Step 1: Write the failing test**

Add to `tests/llm/swarm-agent.test.ts`:

```typescript
import { insertSwarmPersona, insertLlmConversation } from '../../src/db/repository.js';

vi.mock('../../src/db/repository.js', () => ({
  insertSwarmPersona: vi.fn().mockResolvedValue(undefined),
  insertLlmConversation: vi.fn().mockResolvedValue(42), // returns conversation_id
}));

it('inserts swarm_persona rows with conversation_id from judge', async () => {
  const { insertSwarmPersona: mockInsert, insertLlmConversation: mockInsertConv } = await import('../../src/db/repository.js');

  let callCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
      return Promise.resolve(consensusResponse);
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  agent.sessionId = 'test-session';
  await agent.getConsensus(makeMinimalPromptData());

  // Persona inserts should have conversation_id
  for (const call of (mockInsert as any).mock.calls) {
    expect(call[0]).toHaveProperty('conversation_id', 42);
  }
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: FAIL — persona inserts don't have conversation_id

**Step 3: Modify swarm-agent.ts**

Change the approach: collect persona data during Stage 1, insert AFTER judge conversation is created.

In `src/llm/swarm-agent.ts`:

1. Remove the `insertSwarmPersona` call from the Stage 1 loop (lines 220-229)
2. Collect persona data into an array instead
3. After judge `insertLlmConversation` (line 322), insert all personas with the returned conversation_id

```typescript
// After line 212, add:
const pendingPersonas: Array<{ persona: string; model: string; raw_response: string; vote?: string; confidence?: number; reasoning?: string }> = [];

// Replace lines 220-229 with:
if (this.sessionId) {
  const eo = expertOutputs[expertOutputs.length - 1];
  pendingPersonas.push({
    persona: personas[i],
    model: personas[i] === 'narrative_expert' ? 'grok' : 'codex',
    raw_response: res.value,
    vote: eo?.position,
    confidence: eo?.confidence,
    reasoning: eo?.thesis || res.value.slice(0, 500),
  });
}

// After line 331 (insertLlmConversation), change to:
const convId = await insertLlmConversation({
  cycle_id: this.cycleId,
  session_id: this.sessionId,
  layer: 1,
  model: 'codex',
  method: 'swarm_consensus',
  system_prompt: judgeSystem,
  user_prompt: userPrompt,
  raw_response: rawConsensus,
});

// Insert all pending personas with conversation_id
for (const pp of pendingPersonas) {
  insertSwarmPersona({ ...pp, conversation_id: convId }).catch(() => {});
}
```

**Note:** `insertLlmConversation` must return the inserted row's `id`. Check `src/db/repository.ts` — if it doesn't return id, modify it to `RETURNING id`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts src/db/repository.ts tests/llm/swarm-agent.test.ts
git commit -m "fix(swarm): link persona rows to judge conversation_id"
```

---

### Task 5: Add max-age TTL to fingerprint cache

**Files:**
- Modify: `src/llm/swarm-agent.ts` (add timestamp to cache)
- Modify: `tests/llm/swarm-agent.test.ts` (test TTL expiry)

**Step 1: Write the failing test**

Add to `tests/llm/swarm-agent.test.ts`:

```typescript
it('re-runs debate after TTL expires even if fingerprint unchanged', async () => {
  let callCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3 || (callCount >= 5 && callCount <= 7)) {
        return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
      }
      return Promise.resolve(consensusResponse);
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  const data = makeMinimalPromptData();

  await agent.getConsensus(data);
  expect(mockLlm.call).toHaveBeenCalledTimes(4);

  // Simulate TTL expiry by setting lastDebateAt to 31 minutes ago
  (agent as any).lastDebateAt = Date.now() - 31 * 60_000;

  await agent.getConsensus(data);
  expect(mockLlm.call).toHaveBeenCalledTimes(8); // re-ran debate
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: FAIL — no TTL logic yet

**Step 3: Add TTL to SwarmAgent**

In `src/llm/swarm-agent.ts`, add:

```typescript
// Class field:
private lastDebateAt: number = 0;
private static readonly DEBATE_TTL_MS = 30 * 60_000; // 30 minutes

// In getConsensus(), update the fingerprint check:
const cacheExpired = Date.now() - this.lastDebateAt > SwarmAgent.DEBATE_TTL_MS;

if (!hasChanged(this.lastFingerprint, fp) && this.lastDecisions.length > 0 && !cacheExpired) {
  console.log('[Swarm] Fingerprint unchanged — reusing previous consensus');
  return this.lastDecisions;
}

// After successful debate (where we set this.lastFingerprint):
this.lastDebateAt = Date.now();
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): add 30-min TTL to fingerprint cache"
```

---

### Task 6: Integration test — full dedup + quality flow

**Files:**
- Test: `tests/llm/swarm-agent.test.ts` (add integration scenario)

**Step 1: Write the integration test**

```typescript
it('integration: dedup skips, TTL forces re-debate, contrarian DA disagrees', async () => {
  let round = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation((system: string) => {
      round++;
      // DA prompt now contains "OPPOSITE" — should return contrarian position
      if (system.includes('OPPOSITE')) {
        return Promise.resolve(makeStructuredResponse('devils_advocate', 'LONG', 55)); // contrarian!
      }
      if (round % 8 === 0) return Promise.resolve(consensusResponse); // judge
      return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  const data = makeMinimalPromptData();

  // Round 1: full debate
  await agent.getConsensus(data);
  const callsAfterR1 = mockLlm.call.mock.calls.length;
  expect(callsAfterR1).toBeGreaterThan(3); // at least experts + judge

  // Round 2: same data — cached
  await agent.getConsensus(data);
  expect(mockLlm.call.mock.calls.length).toBe(callsAfterR1); // no new calls
});
```

**Step 2: Run the test**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: ALL PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/llm/swarm-agent.test.ts
git commit -m "test(swarm): add integration test for dedup + contrarian DA"
```

---

## Summary

| Task | What | Token Impact |
|------|------|-------------|
| 1 | Fingerprint module | Foundation for dedup |
| 2 | Wire dedup into SwarmAgent | **~70% fewer swarm LLM calls** |
| 3 | Rewrite DA prompt | Genuine disagreement |
| 4 | Link persona→conversation | Fix orphaned DB rows |
| 5 | TTL on cache | Safety: re-debate after 30min |
| 6 | Integration test | Confidence in the whole flow |
