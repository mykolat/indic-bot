# Design: Shark Mode "Soft Filter" (Replacing Hard Block)

## Goal
To allow the LLM to make trading decisions even when market volume or confluence doesn't strictly meet the *Shark Mode* profile requirements, treating those missing requirements as "Warnings" rather than "Hard Blocks." We also need to fix a minor display bug in the audit report where skipped LLM runs print `undefined`.

## Context & Problem
Currently in `src/trading-loop.ts`, the system executes a "pre-flight check" before calling the LLM API:
```typescript
if (btcInd.volumeRatio < activeProfile.volumeMin) {
    skipLlm = true;
    skippedReason = `Volume ${btcInd.volumeRatio.toFixed(2)}x < ${activeProfile.volumeMin}x required for ${marketRegime}`;
}
```
If `skipLlm` becomes true, the loop is completely bypassed, and an error `LLM_SKIPPED_PREFLIGHT` is logged. This saves tokens and enforces discipline but:
1. Prevents the LLM from taking advantage of strong fundamental/narrative setups if volume is temporarily low.
2. Creates logs with `undefined: Volume...` in the `audit.ts` output because it expects an `e.type` instead of `e.code`.

## Proposed Solution: The "Soft Filter"

### 1. Fix Audit "undefined" Bug
In `scripts/audit-md.ts` (and optionally `scripts/audit.ts`), update the error log mapping to fall back to `e.code` if `e.type` is missing.
**Change:**
```typescript
const recentErrors = [...errors].reverse().slice(0, 5).map(e => `    [${e.timestamp}] ${e.code || e.type || '(Audit Error)'}: ${e.message}`).join('\n');
```

### 2. Move Pre-flight Check Output to the LLM Prompt
Instead of skipping the LLM, we will execute the same logic but store the failure reason.
If there is a failure reason (e.g., volume is too low), we pass this string explicitly into `promptData` as a `filterWarning`.

#### Changes in `src/trading-loop.ts`:
1. Remove `let skipLlm = false;` entirely.
2. Introduce `let filterWarning: string | undefined = undefined;`.
3. If volume or confluence fails the `activeProfile` minimums, set `filterWarning = skippedReason;`.
4. Inject `filterWarning` into the `promptData` object passed to `llm.analyze(promptData)`.
5. Remove the `if (skipLlm)` block that bypasses the LLM logic, ensuring the LLM is always called unless a deeper pre-condition fails.

#### Changes in `src/llm/prompts.ts`:
1. Update `EnrichedPromptData` interface to include `filterWarning?: string`.
2. Update `buildEnrichedPrompt()` to inject this warning aggressively if it exists.
Example:
```typescript
if (data.filterWarning) {
    prompt += `\n>>> ⚠️ SHARK MODE WARNING ⚠️ <<<\n`;
    prompt += `System technical filters FAILED: ${data.filterWarning}\n`;
    prompt += `ACTION REQUIRED: You are heavily advised to HOLD. ONLY execute LONG/SHORT if you have EXTREME CONVICTION from news/fundamentals that overrides this technical weakness.\n\n`;
}
```

### 3. Handle `nextCheckMinutes` Optimization
Currently, if the LLM is skipped, `trading-loop.ts` returns `undefined`, which defaults to the `loopIntervalMs` (60s). 
If the LLM now runs *every* time but decides to `HOLD` because of the `filterWarning`, it will naturally output `next_check_minutes` (e.g., 5-30 mins). 
The main loop (`src/index.ts`) already respects this:
```typescript
const nextMs = nextCheckMinutes
  ? Math.max(nextCheckMinutes * 60_000, defaultIntervalMs)
  : defaultIntervalMs;
```
By giving the LLM the power to see the warning, choose to `HOLD`, and set `next_check_minutes: 5-30`, we still save tokens during dead periods without hard-coding skips!

## Testing Strategy
1. **Unit/Integration Test:** Manually run the trading loop or `npm run dev` and ensure the prompt generated contains the `>>> ⚠️ SHARK MODE WARNING ⚠️ <<<` when volume is low.
2. **Audit Report Test:** Run `tsx scripts/audit-md.ts` to ensure previous `LLM_SKIPPED_PREFLIGHT` errors print `LLM_SKIPPED_PREFLIGHT: Volume...` instead of `undefined: Volume...`.

## Acceptance Criteria
- [ ] Audit logs show `LLM_SKIPPED_PREFLIGHT` instead of `undefined`.
- [ ] LLM is invoked even when volume is low, but the prompt clearly warns it of the deficiency.
- [ ] LLM outputs a confident `HOLD` and sets a high `next_check_minutes` when volume is low and no catalysts exist.
