# Issue #16: Swarm Reform — Reduce Personas, Eliminate HOLD Bias

**Status:** Plan
**Created:** 2026-03-06
**Branch:** `feat/max-info-fetch`

## Problem

The swarm system consumes 6-17 LLM calls per activation but produces 86% HOLD votes with a 28% failure rate. Root causes:

1. **Bull + Bear cancel out.** Two personas argue opposite directions, net effect is always uncertainty, judge defaults to HOLD.
2. **Judge prompt explicitly says "lean towards HOLD"** (`src/llm/swarm-agent.ts:176`) — this is a systematic bias when experts disagree.
3. **5 personas are too many for the signal quality.** Market structure expert overlaps with risk manager. Devil's advocate often duplicates bear thesis.
4. **No actionability scoring.** Judge has no way to distinguish "genuine uncertainty" from "strong signal with one dissenter."

**Evidence from code:**

`src/llm/swarm-agent.ts:164-178` — Judge prompt:
```typescript
return `You are the SWARM CONSENSUS JUDGE...
If experts strongly disagree, lean towards HOLD.
If the Risk Manager flags critical danger AND the Devil's Advocate agrees, lean towards CLOSE or HOLD.
```

`src/llm/swarm-agent.ts:192-198` — 5 core personas:
```typescript
const personas: SwarmPersona[] = [
  'risk_manager', 'bull_thesis', 'bear_thesis',
  'market_structure', 'devils_advocate',
];
```

## Solution

1. **Reduce to 3 core personas:** `analyst` (replaces bull+bear+market_structure), `risk_manager`, `grok_challenger` (replaces devils_advocate, uses Grok)
2. **Remove "lean HOLD" from judge prompt** — replace with actionability scoring
3. **Add actionability score** (0-100) to expert output: "how tradeable is this setup?"
4. **Make Grok permanent member** — `grok_challenger` always runs (not conditional on `this.grokLlm`)
5. **Reduce LLM calls:** 3 experts + 3 critiques + 1 judge = 7 max (was 11-17)

This is preparation for Phase 3 tiered expert system where swarm activates only for high-conviction setups.

## Detailed Design

### Persona Changes

| Old Persona | New Persona | Rationale |
|-------------|-------------|-----------|
| `bull_thesis` | Merged into `analyst` | Analyst presents both bull AND bear case, preventing cancellation |
| `bear_thesis` | Merged into `analyst` | Same — single analyst weighs evidence |
| `market_structure` | Merged into `analyst` | Microstructure (funding, OI, book) is part of analysis, not separate |
| `risk_manager` | `risk_manager` (kept) | Clear, distinct role — find reasons NOT to trade |
| `devils_advocate` | `grok_challenger` | Uses Grok model, attacks consensus with live X/Twitter data |
| `narrative_expert` | Merged into `grok_challenger` | Grok already has narrative capability |

### New Expert Output Format

```typescript
export interface ExpertOutput {
  persona: string;
  pair: string;
  position: string;
  thesis: string;
  arguments: string[];
  probability_of_success: number;
  key_risks: string[];
  confidence: number;
  actionability: number;  // NEW: 0-100, how tradeable is this setup RIGHT NOW
}
```

### New Judge Prompt

Remove "lean HOLD" bias. Add weighted actionability:

```typescript
`You are the SWARM CONSENSUS JUDGE managing a LIVE crypto futures account with real money.

Below are structured opinions from expert analysts after ${debateStage}.

WEIGHTING RULES:
- Weight = probability_of_success * confidence * actionability / 10000
- Higher weight = more influence on your decision
- The Grok Challenger's risks get 1.5x weight on the RISK side
- If average actionability < 30: output HOLD (setup is not tradeable)
- If average actionability >= 50 AND analyst probability > 60%: consider entry
- Do NOT default to HOLD. Default to the HIGHEST-WEIGHTED position.

${sections.join('\n\n')}

Based on these expert opinions, produce the final consensus trading decision.
If the Risk Manager flags critical danger (probability < 20%), lean towards CLOSE or HOLD.

You MUST respond with valid JSON:
{"decisions": [...], "next_check_minutes": <1-30>}`
```

### SwarmPersona Type Update

```typescript
export type SwarmPersona =
  | 'analyst'
  | 'risk_manager'
  | 'grok_challenger';
```

## Implementation Steps (TDD)

### Step 1: Test — New ExpertOutput includes actionability field

**File:** `tests/llm/swarm-agent.test.ts`

Add at top, update `makeStructuredResponse`:

```typescript
const makeStructuredResponse = (persona: string, position: string, prob: number, actionability = 50) =>
  JSON.stringify({
    persona,
    pair: 'BTCUSDT',
    position,
    thesis: `${persona} analysis`,
    arguments: ['arg1', 'arg2'],
    probability_of_success: prob,
    key_risks: ['risk1'],
    confidence: 80,
    actionability,
  });
```

Add new test:

```typescript
it('parseExpertOutput extracts actionability field', () => {
  const raw = JSON.stringify({
    persona: 'analyst',
    pair: 'BTCUSDT',
    position: 'LONG',
    thesis: 'breakout',
    arguments: ['a'],
    probability_of_success: 70,
    key_risks: ['r'],
    confidence: 80,
    actionability: 65,
  });
  const result = parseExpertOutput(raw, 'analyst');
  expect(result).not.toBeNull();
  expect(result!.actionability).toBe(65);
});
```

**Run:** `npx vitest run tests/llm/swarm-agent.test.ts`
**Expected:** FAIL — `actionability` not in `ExpertOutput` interface, `parseExpertOutput` doesn't extract it.

### Step 2: Implement — Add actionability to ExpertOutput

**File:** `src/llm/swarm-agent.ts`

Update `ExpertOutput` interface (line 6-15):

```typescript
export interface ExpertOutput {
  persona: string;
  pair: string;
  position: string;
  thesis: string;
  arguments: string[];
  probability_of_success: number;
  key_risks: string[];
  confidence: number;
  actionability: number;  // 0-100: how tradeable is this setup
}
```

`parseExpertOutput` already does `return { ...obj, persona }` so the field will pass through automatically as long as it's in the JSON. No code change needed in parser — just the type.

**Run:** `npx vitest run tests/llm/swarm-agent.test.ts`
**Expected:** PASS — actionability flows through spread operator.

### Step 3: Test — Reformed swarm runs 3 experts + 3 critiques + 1 judge = 7 calls

**File:** `tests/llm/swarm-agent.test.ts`

```typescript
describe('SwarmAgent reformed (3 personas)', () => {
  it('runs 3 experts + 3 critiques + 1 judge = 7 LLM calls', async () => {
    let callCount = 0;
    const mockCodex = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // analyst + risk_manager
          const p = callCount === 1 ? 'analyst' : 'risk_manager';
          return Promise.resolve(makeStructuredResponse(p, callCount === 1 ? 'LONG' : 'HOLD', 65, 60));
        }
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;
    const mockGrok = {
      call: vi.fn().mockResolvedValue(makeStructuredResponse('grok_challenger', 'LONG', 55, 45)),
    } as any;

    const agent = new SwarmAgent(mockCodex, mockGrok);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // 2 Codex experts + 1 Grok expert + 3 critiques + 1 judge = 7
    expect(mockCodex.call).toHaveBeenCalledTimes(6); // 2 experts + 3 critiques + 1 judge
    expect(mockGrok.call).toHaveBeenCalledTimes(1);   // grok_challenger
    expect(decisions).toHaveLength(1);
  });

  it('grok_challenger runs even without grokLlm (falls back to codex)', async () => {
    let callCount = 0;
    const mockCodex = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          const personas = ['analyst', 'risk_manager', 'grok_challenger'];
          return Promise.resolve(makeStructuredResponse(personas[callCount - 1], 'HOLD', 50, 40));
        }
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    // No Grok LLM — should still run 3 personas
    const agent = new SwarmAgent(mockCodex);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // 3 experts + 3 critiques + 1 judge = 7
    expect(mockCodex.call).toHaveBeenCalledTimes(7);
    expect(decisions).toHaveLength(1);
  });
});
```

**Run:** `npx vitest run tests/llm/swarm-agent.test.ts`
**Expected:** FAIL — SwarmAgent still uses 5 personas.

### Step 4: Implement — Reform SwarmAgent.getConsensus()

**File:** `src/llm/swarm-agent.ts`

**4a. Update persona list in `getConsensus()` (lines 190-209):**

Replace:
```typescript
const personas: SwarmPersona[] = [
  'risk_manager', 'bull_thesis', 'bear_thesis',
  'market_structure', 'devils_advocate',
];

const expertCalls = personas.map(p =>
  this.llm.call(buildExpertSystemPrompt(p), userPrompt),
);

if (this.grokLlm) {
  personas.push('narrative_expert');
  expertCalls.push(
    this.grokLlm.call(buildExpertSystemPrompt('narrative_expert'), userPrompt, 'grok-4-1-fast-reasoning'),
  );
}
```

With:
```typescript
const personas: SwarmPersona[] = ['analyst', 'risk_manager', 'grok_challenger'];

const expertCalls: Promise<string>[] = [
  this.llm.call(buildExpertSystemPrompt('analyst'), userPrompt),
  this.llm.call(buildExpertSystemPrompt('risk_manager'), userPrompt),
];

// grok_challenger: prefer Grok, fall back to Codex
if (this.grokLlm) {
  expertCalls.push(
    this.grokLlm.call(buildExpertSystemPrompt('grok_challenger'), userPrompt, 'grok-4-1-fast-reasoning'),
  );
} else {
  expertCalls.push(
    this.llm.call(buildExpertSystemPrompt('grok_challenger'), userPrompt),
  );
}
```

**4b. Update console.log (line 190):**

```typescript
console.log('[Swarm] Multi-Agent Debate: Analyst, RiskMgr, GrokChallenger + Judge');
```

**4c. Update DB insert model detection (line 225):**

Replace:
```typescript
model: personas[i] === 'narrative_expert' ? 'grok' : 'codex',
```
With:
```typescript
model: personas[i] === 'grok_challenger' && this.grokLlm ? 'grok' : 'codex',
```

### Step 5: Implement — New expert system prompts

**File:** `src/llm/prompts.ts`

**5a. Update `SwarmPersona` type (line 569-575):**

```typescript
export type SwarmPersona =
  | 'analyst'
  | 'risk_manager'
  | 'grok_challenger'
  // Legacy — kept for DB compatibility
  | 'bull_thesis'
  | 'bear_thesis'
  | 'market_structure'
  | 'devils_advocate'
  | 'narrative_expert';
```

**5b. Add new persona prompts in `buildExpertSystemPrompt()` (line 593):**

Add before the `switch` statement's existing cases:

```typescript
case 'analyst':
  personaPrefix = `You are the CHIEF MARKET ANALYST analyzing crypto futures on a LIVE account with real money.
You present BOTH the bull AND bear case, then give your final verdict.

Structure your analysis:
1. BULL CASE: What supports going long? (trend, momentum, volume, news catalysts, support levels)
2. BEAR CASE: What supports going short? (overbought, resistance, divergences, macro headwinds)
3. MARKET STRUCTURE: Funding rate, OI, order book, L/S ratio — who is positioned how?
4. VERDICT: Which side has stronger evidence? Be decisive. Assign probability_of_success to your chosen position.

Your "actionability" score (0-100) measures: Is this a clean setup to trade RIGHT NOW?
- 80+: Textbook entry — multiple confirmations, clear SL/TP, volume supports
- 50-80: Decent setup — some confirmations, some noise
- 20-50: Marginal — could go either way, wouldn't risk much
- <20: No setup — wait for clarity

Be specific: cite exact indicator values and price levels from the data.`;
  break;

case 'grok_challenger':
  personaPrefix = `You are the GROK CHALLENGER — the adversarial stress-tester with live X/Twitter intelligence, analyzing crypto futures on a LIVE account with real money.
Your job is to ATTACK the consensus and find what others are missing.

1. Find blind spots, assumptions, and logical flaws
2. Check: Is the crowd positioned one way? (contrarian signal)
3. What black swan or tail risk is being ignored?
4. Challenge: "What if the opposite happens? What are we missing?"
5. Point out: confirmation bias, recency bias, anchoring to entry price
6. What is X/Twitter saying that contradicts the technical picture?

Your "actionability" score reflects YOUR confidence that this trade should be AVOIDED:
- High actionability (70+): You found NO compelling reason to block the trade
- Medium (40-70): You have concerns but they're not dealbreakers
- Low (<40): You found serious red flags — this trade should NOT happen

You are NOT a defender of any position. You are the stress-tester.`;
  break;
```

**5c. Update `EXPERT_OUTPUT_FORMAT` (line 577-591):**

Add `actionability` field:

```typescript
const EXPERT_OUTPUT_FORMAT = `
You MUST respond with ONLY this JSON (no markdown, no explanation):
{
  "persona": "<your_persona_name>",
  "pair": "<pair>",
  "position": "LONG" | "SHORT" | "HOLD" | "CLOSE",
  "thesis": "<1-2 sentence core argument>",
  "arguments": ["<argument 1>", "<argument 2>", "<argument 3>"],
  "probability_of_success": <0-100>,
  "key_risks": ["<risk 1>", "<risk 2>"],
  "confidence": <0-100>,
  "actionability": <0-100>
}

For multiple pairs, return an array of these objects.
Output ONLY valid JSON. No text before or after.`;
```

### Step 6: Implement — Reformed judge prompt

**File:** `src/llm/swarm-agent.ts`

Replace `buildJudgePrompt()` (lines 129-179):

```typescript
export function buildJudgePrompt(expertOutputs: (ExpertOutput | null)[], rawTexts: string[], personas: SwarmPersona[], critiqueOutputs?: (CritiqueOutput | null)[], reviseOutputs?: (ReviseOutput | null)[]): string {
  const sections: string[] = [];
  for (let i = 0; i < expertOutputs.length; i++) {
    const eo = expertOutputs[i];
    const rev = reviseOutputs?.[i];
    const crit = critiqueOutputs?.[i];

    if (rev) {
      sections.push(`## ${personas[i].toUpperCase()} (REVISED)
Original position: ${rev.original_position} → Revised: ${rev.revised_position} ${rev.changed_mind ? '(CHANGED MIND)' : '(HELD)'}
Thesis: ${rev.revised_thesis}
Arguments: ${rev.revised_arguments.join('; ')}
probability_of_success: ${rev.revised_probability}%
Concessions: ${rev.key_concessions.join('; ')}
Confidence: ${rev.final_confidence}/100`);
    } else if (eo) {
      let section = `## ${eo.persona.toUpperCase()}
Position: ${eo.position}
Thesis: ${eo.thesis}
Arguments: ${eo.arguments.join('; ')}
probability_of_success: ${eo.probability_of_success}%
Key risks: ${eo.key_risks.join('; ')}
Confidence: ${eo.confidence}/100
Actionability: ${eo.actionability ?? 'N/A'}/100`;
      if (crit) {
        section += `\nAfter critique — updated position: ${crit.updated_position}, probability: ${crit.updated_probability}%`;
        section += `\nStrongest risk found: ${crit.strongest_risk_found}`;
      }
      sections.push(section);
    } else {
      sections.push(`## ${personas[i].toUpperCase()} (parse failed)\n${rawTexts[i]?.slice(0, 500) ?? 'no output'}`);
    }
  }

  // Compute average actionability for threshold
  const validExperts = expertOutputs.filter((eo): eo is ExpertOutput => eo !== null);
  const avgActionability = validExperts.length > 0
    ? validExperts.reduce((sum, eo) => sum + (eo.actionability ?? 50), 0) / validExperts.length
    : 50;

  const debateStage = reviseOutputs ? '3-stage debate (generate → critique → revise)' : critiqueOutputs ? '2-stage debate (generate → critique)' : 'single-stage';

  return `You are the SWARM CONSENSUS JUDGE managing a LIVE crypto futures account with real money.

Below are structured opinions from expert analysts after ${debateStage}.

WEIGHTING RULES:
- Weight each expert by: probability_of_success * confidence * actionability / 10000
- Higher weight = more influence on your decision
- The Grok Challenger's identified risks get 1.5x weight on the RISK side
- Experts who changed their mind after critique show intellectual honesty — weight their revised view higher
- Average actionability across experts: ${avgActionability.toFixed(0)}/100

DECISION FRAMEWORK:
- If average actionability < 30: The setup is NOT tradeable — output HOLD
- If average actionability >= 50 AND analyst probability > 60%: Seriously consider entry
- Do NOT default to HOLD when experts disagree — default to the HIGHEST-WEIGHTED position
- Only output HOLD if the data genuinely does not support any direction
- If the Risk Manager flags critical danger (probability < 20%), lean towards CLOSE or HOLD

${sections.join('\n\n')}

Based on these expert opinions, produce the final consensus trading decision.

You MUST respond with valid JSON:
{"decisions": [{"pair": "<pair>", "action": "LONG|SHORT|HOLD|CLOSE", "size_pct": <number>, "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "confidence": <0-100>, "reasoning": "<string>"}], "next_check_minutes": <1-30>}`;
}
```

### Step 7: Verify — Run all swarm tests

**Run:** `npx vitest run tests/llm/swarm-agent.test.ts`

**Expected:** Some old tests will FAIL because they expect 5 personas and 11/16 call counts.

### Step 8: Update old tests for new persona count

**File:** `tests/llm/swarm-agent.test.ts`

Update the first test (line 39-63):
```typescript
it('runs 3 experts + 3 critiques + 1 judge = 7 LLM calls (no Grok)', async () => {
  let callCount = 0;
  const mockRawCall = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount <= 3) {
      const personas = ['analyst', 'risk_manager', 'grok_challenger'];
      return Promise.resolve(makeStructuredResponse(personas[callCount - 1], 'HOLD', 60, 45));
    }
    return Promise.resolve(consensusResponse);
  });
  const mockLlm = {
    call: mockRawCall,
    analyze: vi.fn(),
    model: 'test-model',
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  const decisions = await agent.getConsensus(makeMinimalPromptData());

  // 3 experts + 3 critiques + 1 judge = 7
  expect(mockRawCall).toHaveBeenCalledTimes(7);
  expect(decisions).toHaveLength(1);
  expect(decisions[0].action).toBe('HOLD');
});
```

Update Grok test (line 65-87):
```typescript
it('with Grok: 2 Codex experts + 1 Grok + 3 critiques + 1 judge = 7 total', async () => {
  let codexCallCount = 0;
  const mockCodex = {
    call: vi.fn().mockImplementation(() => {
      codexCallCount++;
      if (codexCallCount <= 2) {
        return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 55, 40));
      }
      return Promise.resolve(consensusResponse);
    }),
    lastNextCheckMinutes: undefined,
  } as any;
  const mockGrok = {
    call: vi.fn().mockResolvedValue(makeStructuredResponse('grok_challenger', 'HOLD', 50, 35)),
  } as any;

  const agent = new SwarmAgent(mockCodex, mockGrok);
  await agent.getConsensus(makeMinimalPromptData());

  // 2 Codex experts + 3 critiques + 1 judge = 6 Codex calls
  expect(mockCodex.call).toHaveBeenCalledTimes(6);
  expect(mockGrok.call).toHaveBeenCalledTimes(1);
});
```

Update revise test (line 108-128):
```typescript
it('runs revise stage (3-stage) when high-stakes detected', async () => {
  let callCount = 0;
  const mockLlm = {
    call: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        const personas = ['analyst', 'risk_manager', 'grok_challenger'];
        return Promise.resolve(makeStructuredResponse(personas[callCount - 1], 'HOLD', 60, 50));
      }
      return Promise.resolve(consensusResponse);
    }),
    lastNextCheckMinutes: undefined,
  } as any;

  const agent = new SwarmAgent(mockLlm);
  const decisions = await agent.getConsensus(makeHighStakesPromptData());

  // 3 experts + 3 critiques + 3 revises + 1 judge = 10
  expect(mockLlm.call).toHaveBeenCalledTimes(10);
  expect(decisions).toHaveLength(1);
});
```

Update judge prompt test (line 130-168):
```typescript
it('judge prompt contains actionability and no HOLD bias', () => {
  const expertOutputs = [
    {
      persona: 'analyst', pair: 'BTCUSDT', position: 'LONG',
      thesis: 'Breakout confirmed', arguments: ['EMA crossover'],
      probability_of_success: 75, key_risks: ['false breakout'],
      confidence: 80, actionability: 65,
    },
    {
      persona: 'risk_manager', pair: 'BTCUSDT', position: 'HOLD',
      thesis: 'Too risky', arguments: ['high volatility'],
      probability_of_success: 30, key_risks: ['liquidation'],
      confidence: 90, actionability: 40,
    },
    null, // grok_challenger failed
  ];
  const rawTexts = ['', '', 'raw grok text'];
  const personas = ['analyst', 'risk_manager', 'grok_challenger'] as any;

  const prompt = buildJudgePrompt(expertOutputs, rawTexts, personas);

  expect(prompt).toContain('ANALYST');
  expect(prompt).toContain('RISK_MANAGER');
  expect(prompt).toContain('GROK_CHALLENGER (parse failed)');
  expect(prompt).toContain('Actionability: 65/100');
  expect(prompt).toContain('Actionability: 40/100');
  expect(prompt).toContain('SWARM CONSENSUS JUDGE');
  // Should NOT contain old HOLD bias
  expect(prompt).not.toContain('lean towards HOLD');
  // Should contain new framework
  expect(prompt).toContain('HIGHEST-WEIGHTED position');
  expect(prompt).toContain('Average actionability');
});
```

### Step 9: Verify — All tests pass

**Run:** `npx vitest run tests/llm/swarm-agent.test.ts`
**Expected:** PASS

**Run:** `npx vitest run tests/`
**Expected:** PASS (no regressions)

### Step 10: Commit

```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(#16): swarm reform — 3 personas, actionability scoring, remove HOLD bias"
```

## Files Modified

| File | Change |
|------|--------|
| `src/llm/swarm-agent.ts` | Reduce personas to 3, add actionability to ExpertOutput, reform judge prompt, make grok_challenger permanent |
| `src/llm/prompts.ts` | Update SwarmPersona type, add `analyst` + `grok_challenger` system prompts, add actionability to expert output format |
| `tests/llm/swarm-agent.test.ts` | Update all call-count expectations, add actionability tests, update judge prompt assertions |

## LLM Call Budget Comparison

| Scenario | Before | After |
|----------|--------|-------|
| No Grok, no revise | 5 + 5 + 1 = 11 | 3 + 3 + 1 = 7 |
| With Grok, no revise | 6 + 6 + 1 = 13 | 3 + 3 + 1 = 7 |
| With Grok + revise | 6 + 6 + 6 + 1 = 19 | 3 + 3 + 3 + 1 = 10 |

**Savings:** 36-47% fewer LLM calls per swarm activation.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Single analyst may still HOLD if unclear | Actionability scoring forces explicit assessment of setup quality |
| Grok challenger without Grok model | Falls back to Codex with same prompt — still valuable as adversarial agent |
| Losing specialized bull/bear perspectives | Analyst prompt explicitly requires BOTH cases before verdict |
| DB/logs reference old persona names | Keep old names in SwarmPersona union type for backward compat |
| LLMs may not fill actionability | Default to 50 in parser; `eo.actionability ?? 50` in judge |

## Dependencies

- None — self-contained refactor
- Should deploy after Issue #15 (per-pair confluence) for full benefit
- Prepares ground for Phase 3 tiered expert system (not in scope)
