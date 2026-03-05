# Design: Hybrid Memorykeeper & Static Soul

## Goal
Implement a fast, 80/20 solution to separate the bot's static personality (`SOUL.md`) from its dynamic runtime memory (`MEMORY.md`), while preserving a history of the memory's evolution for auditing purposes without over-engineering complex JSON databases.

## Architecture

### 1. Static `SOUL.md` (The Constitution)
- Contains the bot's core identity, persona, and immutable rules.
- Manually edited by the user.
- **Never** overwritten or altered by the bot.

### 2. Dynamic `MEMORY.md` (The Diary)
- Contains runtime reflections: lessons learned, failure patterns, and current market regime views.
- Maintained by the LLM via the `MemoryReviewAgent` (formerly `SoulReviewAgent`).
- The entire file is overwritten during a review cycle to keep it concise and relevant for the main trading loop prompt (saving tokens and maintaining focus).

### 3. History Backups (The 80/20 Audit Solution)
- Before the `MemoryReviewAgent` overwrites `MEMORY.md`, the `MemoryKeeper` (formerly `SoulKeeper`) will make a simple file copy of the **old** `MEMORY.md`.
- It will save this copy to `docs/deepresult/memory_history/memory_YYYY-MM-DDTHH-mm-ss.md`.
- **Why this is the 80/20 solution:** It requires zero database logic, zero JSON parsing, and zero complex API changes. It instantly provides full historical snapshots of the bot's mind that you can read or diff later, exactly like the audit system.

## Implementation Steps

1. **Rename & Refactor:**
   - Rename `src/memory/soul-keeper.ts` to `memory-keeper.ts`.
   - Rename `src/memory/soul-review.ts` to `memory-review.ts`.
   - Update `src/index.ts` and `src/trading-loop.ts` to use "Memory" instead of "Soul" for the dynamic parts.
   
2. **Setup Static `SOUL.md`:**
   - Modify `src/trading-loop.ts` or `src/llm/prompts.ts` to read `data/soul.md` once at startup as a static string.

3. **Implement Backup Logic:**
   - In `MemoryKeeper.writeNarrativeSections()`, before writing the new content to `data/memory.md`, read the existing content and write it to `docs/deepresult/memory_history/memory_<timestamp>.md`.

4. **Update LLM Prompts:**
   - Ensure the trading loop injects both the static `SOUL.md` and the dynamic `MEMORY.md` into the context window.
