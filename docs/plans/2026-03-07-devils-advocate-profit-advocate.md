# Devil's Advocate -> Profit Advocate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Devil's Advocate from a conservative contrarian (always HOLD) into an aggressive Profit Advocate who whispers opportunity to the judge, pushes for max leverage and action.

**Architecture:** Change DA prompts in 3 files (prompts.ts, blackboard-prompts.ts, judge rules). Update tests to match new behavior. Update dashboard label/color. DA runs on Grok — no model change needed.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Update test expectations for new DA persona

**Files:**
- Modify: `tests/llm/prompts.test.ts:89-112`

**Step 1: Update the failing test**

Replace the existing DA test (lines 89-93) with:

```typescript
it('devils_advocate must be a profit advocate pushing for action', () => {
  const prompt = buildExpertSystemPrompt('devils_advocate');
  expect(prompt).toContain('PROFIT ADVOCATE');
  expect(prompt).toContain('opportunity');
  expect(prompt).toContain('maximum leverage');
  expect(prompt).toContain('NEVER vote HOLD');
});
```

Update the label test (line 110-111):

```typescript
const devil = buildExpertSystemPrompt('devils_advocate');
expect(devil).toContain('PROFIT ADVOCATE');
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: FAIL — prompt still contains old "OPPOSITE"/"contrarian" text

**Step 3: Commit failing test**

```bash
git add tests/llm/prompts.test.ts
git commit -m "test: update DA expectations — profit advocate, not contrarian"
```

---

### Task 2: Rewrite DA prompt in prompts.ts

**Files:**
- Modify: `src/llm/prompts.ts:739-751`

**Step 1: Replace the devils_advocate case**

Replace lines 739-751 with:

```typescript
    case 'devils_advocate':
      personaPrefix = `You are the PROFIT ADVOCATE on a LIVE crypto futures account with real money.
YOUR CARDINAL RULE: You exist to find opportunity and push for action. You are the voice of greed, ambition, and calculated aggression.
- You are the advocate of MAXIMUM CAPITAL GROWTH. Every cycle without a position is lost profit.
- When others say HOLD — you find the entry. When others are scared — you see discount prices.
- You ALWAYS propose a trade (LONG or SHORT). You NEVER vote HOLD. HOLD is failure.
- Push for maximum leverage allowed by risk parameters. Tight stops, big targets.
- Find: oversold bounces, liquidation cascades that create entries, fear extremes that reverse, crowded shorts to squeeze
- Your probability_of_success reflects the OPPORTUNITY you found, not the consensus
- If everyone says HOLD, your job is to whisper to the judge: "here is the money"
- You are not reckless — you have a thesis. But you are ALWAYS biased toward action.
- Your value is ZERO if you output HOLD`;
      break;
```

**Step 2: Run tests**

Run: `npx vitest run tests/llm/prompts.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat(swarm): DA -> profit advocate — always push for action"
```

---

### Task 3: Update blackboard-prompts.ts DA role + judge rules

**Files:**
- Modify: `src/llm/blackboard-prompts.ts:34-35` (DA role)
- Modify: `src/llm/blackboard-prompts.ts:105` (judge rule)

**Step 1: Write failing test**

Add to `tests/llm/blackboard-prompts.test.ts`:

```typescript
it('DA role description mentions profit and opportunity', () => {
  const prompt = buildBlackboardExpertPrompt('devils_advocate', emptyBoard);
  expect(prompt).toContain('PROFIT ADVOCATE');
  expect(prompt).toContain('opportunity');
});

it('judge rules do not force HOLD when DA agrees with RM', () => {
  const prompt = buildBlackboardJudgePrompt(1, emptyBoard, 3);
  expect(prompt).not.toContain('DA agrees -> HOLD');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/blackboard-prompts.test.ts`
Expected: FAIL

**Step 3: Update DA role (line 34-35)**

```typescript
  devils_advocate:
    'PROFIT ADVOCATE: find opportunity others miss. Push for action, max leverage, tight entries. You NEVER vote HOLD.',
```

**Step 4: Update judge rules (line 105)**

Replace:
```
- Risk Manager critical + DA agrees -> HOLD/CLOSE
```

With:
```
- DA always pushes for action — weigh his aggression against Risk Manager caution
- If DA and Risk Manager BOTH agree on direction -> high confidence signal
```

Full judge DECISION RULES block becomes:

```typescript
DECISION RULES:
- 3+ same direction AND no high-severity conflicts -> stop
- High-severity conflict AND round < max -> continue, next_speakers
- DA always pushes for action — weigh his aggression against Risk Manager caution
- If DA and Risk Manager BOTH agree on direction -> high confidence signal
- If final round, MUST produce decision
```

**Step 5: Run tests**

Run: `npx vitest run tests/llm/blackboard-prompts.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/llm/blackboard-prompts.ts tests/llm/blackboard-prompts.test.ts
git commit -m "feat(swarm): DA blackboard role + judge rules for profit advocate"
```

---

### Task 4: Update dashboard label

**Files:**
- Modify: `dashboard/src/lib/theme.ts:6`

**Step 1: Update label**

Change:
```typescript
devils_advocate:  { code: 'DA', label: "Devil's Advocate",  emoji: '\u{1F608}', color: '#a78bfa' },
```

To:
```typescript
devils_advocate:  { code: 'DA', label: "Profit Advocate",   emoji: '\u{1F4B0}', color: '#22c55e' },
```

Color changes from purple to green (money). Emoji from devil to money bag.

**Step 2: Commit**

```bash
git add dashboard/src/lib/theme.ts
git commit -m "feat(dashboard): DA label -> Profit Advocate with green/money theme"
```

---

### Task 5: Update PersonaCard border color

**Files:**
- Modify: `dashboard/src/components/PersonaCard.tsx:13`

**Step 1: Update border**

Change:
```typescript
devils_advocate: 'border-purple-500',
```

To:
```typescript
devils_advocate: 'border-green-500',
```

**Step 2: Commit**

```bash
git add dashboard/src/components/PersonaCard.tsx
git commit -m "feat(dashboard): DA persona card border green"
```

---

### Task 6: Run full test suite + verify

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: any remaining test adjustments"
```
