---
name: audit
description: Generate a professional Markdown audit report in Ukrainian with comparison diffs to historical bot runs.
---

# Audit Reporting Skill

## Overview
Do NOT query Binance or try to calculate PnL manually! The `indic-bot` has a built-in deterministic script for this.

## Steps
1. Run `npm run audit:md` using your terminal command tool.
2. The script will output the path to a newly generated Markdown file (e.g. `docs/deepresult/audit_history/audit_XXXX-XX-XX.md`).
3. View the generated Markdown file using the `view_file` tool (it will be in Ukrainian).
4. Summarize the contents of the report for the User directly in the chat, keeping the Ukrainian structure intact, and confirm that the archive has been saved.
