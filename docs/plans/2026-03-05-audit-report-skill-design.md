# Audit Reporting Skill Design

## 1. Overview
The user wants a dedicated Agent Skill (`.agents/skills/audit/SKILL.md`) that generates a professional Markdown audit report in Ukrainian. It will use a deterministic TypeScript script (`scripts/audit-md.ts`) to handle the heavy lifting (data gathering, diff calculation, and Markdown generation).

## 2. Approach: "Reporting Script" (Option B)
- **`scripts/audit-md.ts`**: A standalone script that imports logic from `scripts/audit.ts`.
  - Parses Binance API and logs to gather an `AuditData` JSON object.
  - Loads the previous `audit_*.json` from `docs/deepresult/audit_history/` to compute differences (Δ).
  - Generates the Markdown report (`audit_*.md`) with a deterministic conclusion ("Висновок") based on PnL and active regimes.
  - Appends the raw terminal output from `audit:bot` at the bottom.
- **`package.json`**: Add new command `"audit:md": "tsx scripts/audit-md.ts"`.
- **`.agents/skills/audit/SKILL.md`**: The actual Agent instruction file.
  - Explains that when the user invokes the audit skill, the Agent must run `npm run audit:md`.
  - Tells the Agent to then read the resulting Markdown file path from the script output.
  - Tells the Agent to present the summary to the user in Ukrainian.

## 3. Implementation Steps
1. Revert recent `audit.ts` modifications (remove `AuditData` interfaces) to keep it clean for terminal output only.
2. Create `scripts/audit-md.ts`.
3. Update `package.json` with the new command.
4. Create `.agents/skills/audit/SKILL.md` with explicit instructions.
5. Create `.agents/skills/audit/schema.json` if needed (optional for basic execution).
