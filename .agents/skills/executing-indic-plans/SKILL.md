---
name: executing-indic-plans
description: Use when you have a written implementation plan in `docs/plans/` and need to execute it step-by-step.
---

# Executing Indic Plans

## Overview
Load an implementation plan, review it critically, and execute tasks exactly as written. This ensures disciplined, test-driven execution without hallucinating extra features. 

## The Process

### Step 1: Load and Review Plan
1. Read the plan file in `docs/plans/`.
2. Review critically - identify any missing file paths, circular dependencies, or typescript issues.
3. If there are major concerns, stop and ask the user.

### Step 2: Execute Task by Task
For each task:
1. Mark it as in-progress in task.md, or announce it in your context.
2. Follow each step EXACTLY (Plan has bite-sized 1-5 steps).
3. **DO NOT skip Step 1 and 2 (Failing Tests).** You MUST write the test first, see it fail, then write the implementation, then see it pass.
4. If a test fails unexpectedly during Step 4, stop and fix it before moving to Step 5.
5. Create the specified git commit with the `#gemini` tag.

### Step 3: Stop or Ask for Help
- Stop immediately if tests fail repeatedly.
- Stop if a dependency is missing.
- Ask for clarification; do not guess or write massive amounts of undocumented code.

## Remember
- DRY, YAGNI, TDD.
- Vitest is the testing framework.
- Always use `npx vitest run ...` instead of just `vitest`.
