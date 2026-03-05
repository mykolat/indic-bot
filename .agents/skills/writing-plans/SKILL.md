---
name: writing-plans
description: Use when you have a design or architectural spec and need to create a step-by-step implementation plan before touching code.
---

# Writing Implementation Plans

## Overview
Write comprehensive implementation plans assuming the engineer has zero context for the Indic Bot codebase. Document exactly which TS files to touch, which tests to write (Vitest), and how to verify. Break the whole plan into bite-sized, deterministic tasks. Adhere to DRY, YAGNI, and strict Test-Driven Development (TDD).

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>-implementation.md`

## Task Granularity
Each step MUST be a single, 2-5 minute action:
- "Write the failing test" (Provide the exact Vitest code)
- "Run it to make sure it fails" (Provide `npx vitest run ...`)
- "Write minimal implementation" (Provide the exact Typescript code)
- "Run tests to verify passing"
- "Commit" (Use logical commits with `#gemini` tag)

## Plan Document Header
Every plan MUST start with exactly this header:

```markdown
# [Feature Name] Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** [One sentence describing what this achieves]

**Architecture:** [2-3 sentences about the approach]

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---
```

## Task Structure (Strict Format)

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145`
- Test: `tests/exact/path/to/test.ts`

**Step 1: Write the failing test**
```typescript
// Vitest code here
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/path/test.ts`

**Step 3: Write minimal implementation**
```typescript
// Typescript code here
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/path/test.ts`

**Step 5: Commit**
```bash
git add tests/path/test.ts src/path/file.ts
git commit -m "feat: add specific feature #gemini"
```
````
