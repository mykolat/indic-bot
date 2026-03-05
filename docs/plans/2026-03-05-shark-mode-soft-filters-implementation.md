# Shark Mode Soft Filters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Transform Shark Mode's strict pre-flight requirements into a "Soft Filter" that injects warnings into the LLM prompt, fixing audit logs and capping sleep times.

**Architecture:** Instead of hard-bypassing the LLM execution (`skipLlm = true`), we will assign the failure reason to a new `filterWarning` variable, pass it into `promptData`, and inject a high-priority warning into the `prompts.ts` generation. We will also cap `nextCheckMinutes` to 5 minutes if positions are open.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Fix `undefined` bug in Audit Scripts

**Files:**
- Modify: `scripts/audit-md.ts:88-100` (Approximate lines handling recentErrors)
- Modify: `scripts/audit.ts` (Mirror the fix for recentErrors)

**Step 1: Write the failing test**
*(No formal Vitest for script execution output, but we will run a dry run.)*
Run `tsx scripts/audit-md.ts` and observe the `undefined: Volume...` in the console/markdown.

**Step 2: Run test to verify it fails**
Run: `npm run audit:md`

**Step 3: Write minimal implementation**
```typescript
// In scripts/audit-md.ts and scripts/audit.ts
// Find the line that maps `errors` to `recentErrors`:
// const recentErrors = [...errors].reverse().slice(0, 5).map(e => `    [${e.timestamp}] ${e.type}: ${e.message}`).join('\n');
// Replace with:
const recentErrors = [...errors].reverse().slice(0, 5).map(e => `    [${e.timestamp}] ${e.code || e.type || '(Audit Error)'}: ${e.message}`).join('\n');
```

**Step 4: Run test to verify it passes**
Run: `npm run audit:md` -> Check generated Markdown for `LLM_SKIPPED_PREFLIGHT` instead of `undefined`.

**Step 5: Commit**
```bash
git add scripts/audit-md.ts scripts/audit.ts
git commit -m "fix(audit): display error code instead of undefined #gemini"
```

---

### Task 2: Inject `filterWarning` into Prompt Generation

**Files:**
- Modify: `src/llm/prompts.ts`
- Test: `src/llm/__tests__/prompts.test.ts` (Assuming a tests folder, or create a mock test file if it doesn't exist)

**Step 1: Write the failing test**
```typescript
// Create tests/llm/prompts.test.ts
import { describe, it, expect } from 'vitest';
import { buildUserPrompt } from '../../src/llm/prompts.js';

describe('buildUserPrompt', () => {
  it('should inject filterWarning if provided', () => {
    const prompt = buildUserPrompt({
      snapshots: [],
      indicators: new Map(),
      portfolio: { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 },
      signals: [],
      news: [],
      fearGreed: { value: 50, label: 'Neutral' },
      filterWarning: 'Volume 0.3x < 0.6x',
    });
    expect(prompt).toContain('>>> ⚠️ SHARK MODE WARNING ⚠️ <<<');
    expect(prompt).toContain('System technical filters FAILED: Volume 0.3x < 0.6x');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/prompts.test.ts`

**Step 3: Write minimal implementation**
```typescript
// In src/llm/prompts.ts
export interface EnrichedPromptData {
  // ... existing fields ...
  filterWarning?: string;
}

// Inside buildEnrichedPrompt(), right after the regime section:
if (data.filterWarning) {
  prompt += `\n>>> ⚠️ SHARK MODE WARNING ⚠️ <<<\n`;
  prompt += `System technical filters FAILED: ${data.filterWarning}\n`;
  prompt += `ACTION REQUIRED: You are heavily advised to HOLD. ONLY execute LONG/SHORT if you have EXTREME CONVICTION from news/fundamentals that overrides this technical weakness.\n\n`;
}

// In buildSystemPrompt()
// Update the next_check_minutes section:
// - Open positions → 1-5 min (monitor SL/TP, exits)
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/prompts.test.ts`

**Step 5: Commit**
```bash
git add src/llm/prompts.ts tests/llm/prompts.test.ts
git commit -m "feat(llm): inject filterWarning into enriched prompt to create soft filter #gemini"
```

---

### Task 3: Replace Hard Block with Soft Filter in Trading Loop

**Files:**
- Modify: `src/trading-loop.ts`

**Step 1: Write the failing test**
*(Trading loop is complex to test via Vitest, we will rely on TypeScript compiler safety for this refactor and runtime unit test checking).*

**Step 2: Run test to verify it fails**
Run: `npx tsc --noEmit`

**Step 3: Write minimal implementation**
```typescript
// In src/trading-loop.ts
// Replace:
// let skipLlm = false;
// let skippedReason = '';

// With:
let filterWarning: string | undefined = undefined;

// Replace: skipLlm = true; skippedReason = ...
// With: filterWarning = `Volume ${btcInd.volumeRatio.toFixed(2)}x < ${activeProfile.volumeMin}x required for ${marketRegime}`;

// Inject into promptData:
const promptData = {
  // ...
  regime: marketRegime,
  layer1Reports,
  filterWarning, // INJECTED
};

// Remove the hard block check:
// if (skipLlm) {
//   console.log(`[Loop] Pre-flight filter: Skipping LLM analysis — ${skippedReason}`);
//   logger.logError('LLM_SKIPPED_PREFLIGHT', skippedReason);
//   decisions = [];
// } else {
//    // ...
// }

// Allow LLM to analyze unconditionally, with the warning injected.
try {
  if (filterWarning) {
    console.log(`[Loop] Pre-flight warning: ${filterWarning} (Passing to LLM as Soft Filter)`);
    logger.logError('LLM_PREFLIGHT_WARNING', filterWarning); // Optional: rename error code or keep it
  }
  decisions = await llm.analyze(promptData);
} catch (llmErr: any) {
  // ...
}

// Limit nextCheckMinutes for open positions to 5 instead of 2:
const hasPositions = portfolio.positions.length > 0;
if (hasPositions && (nextCheckMinutes === undefined || nextCheckMinutes > 5)) {
  nextCheckMinutes = 5;
}
```

**Step 4: Run test to verify it passes**
Run: `npx tsc --noEmit` to verify type safety.

**Step 5: Commit**
```bash
git add src/trading-loop.ts
git commit -m "feat(trading): replace hard block with soft filter warning, cap timeout at 5m #gemini"
```
