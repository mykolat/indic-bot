# Audit Reporting Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Implement a programmatic Audit Script (`scripts/audit-md.ts`) that outputs strict JSON and Markdown (Ukrainian), and create an Agent Skill (`SKILL.md`) to run it predictably.

**Architecture:** A new deterministic TypeScript script (`audit-md.ts`) runs to parse Binance data and historical archives without `console.log` noise. A new `index.js` or `SKILL.md` inside `.agents/skills/audit/` instructs the LLM on exactly how to invoke this new script. 

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Create the new `audit-md.ts` Script

**Files:**
- Create: `scripts/audit-md.ts`
- Modify: `package.json`

**Step 1: Write the failing test** (N/A for full script execution, but we'll create a basic import test)
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
describe('Audit MD Script', () => {
  it('Should have an executable script', () => {
    expect(existsSync('scripts/audit-md.ts')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/audit/audit-md.test.ts` (Should fail or not exist).

**Step 3: Write minimal implementation**
- **Action A:** Duplicate the data-fetching architecture of `scripts/audit.ts` into a new `scripts/audit-md.ts` file, but replace all `console.log` with internal `AuditData` object assignment.
- **Action B:** Add the file-saving logic to `docs/deepresult/audit_history/audit_YYYY-MM-DD.md`. (Use the diff comparison to previous `audit_*.json`).
- **Action C:** Update `package.json` with `"audit:md": "tsx scripts/audit-md.ts"`.

**Step 4: Run test to verify it passes**
Run: `npm run audit:md` to ensure it successfully generates the `.md` and `.json` files in the history dir.

**Step 5: Commit**
```bash
git add scripts/audit-md.ts package.json
git commit -m "feat: add programmatic audit-md script #gemini"
```

---

### Task 2: Create the Agent Skill `.agents/skills/audit/SKILL.md`

**Files:**
- Create: `.agents/skills/audit/SKILL.md`

**Step 1: Write the failing test**
(Test by manual inspection since SKILLs are read by agents)
```typescript
import { existsSync } from 'fs';
import { describe, it, expect } from 'vitest';
describe('Audit Skill', () => {
  it('Has a SKILL.md defined', () => {
    expect(existsSync('.agents/skills/audit/SKILL.md')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**
Run `npx vitest run tests/audit/skill.test.ts`

**Step 3: Write minimal implementation**
Create `.agents/skills/audit/SKILL.md` with:
```markdown
---
name: audit
description: Generate a professional Markdown audit report in Ukrainian with comparison diffs to historical bot runs.
---

# Audit Reporting Skill

## Overview
Do NOT query Binance or try to calculate PnL manually! The `indic-bot` has a built-in deterministic script for this.

## Steps
1. Run \`npm run audit:md\` using your terminal command tool.
2. The script will output the path to a newly generated Markdown file (e.g. \`docs/deepresult/audit_history/audit_XXXX-XX-XX.md\`).
3. View the generated Markdown file using the \`view_file\` tool (it will be in Ukrainian).
4. Summarize the contents of the report for the User directly in the chat, keeping the Ukrainian structure intact, and confirm that the archive has been saved.
```

**Step 4: Run test to verify it passes**
Run `npx vitest run tests/audit/skill.test.ts`

**Step 5: Commit**
```bash
git add .agents/skills/audit/SKILL.md
git commit -m "docs: add agent skill for audit reporting #gemini"
```
