# Implementation Plan: MemoryKeeper & Static Soul

## Overview
This plan details the steps to transition from a dynamic `soul.md` to a static `soul.md` + dynamic `memory.md` with historical backups (the 80/20 solution).

## Task 1: Rename Files & Refactor Naming (No logic changes)
1. Rename `src/memory/soul-keeper.ts` to `src/memory/memory-keeper.ts`.
2. Rename `src/memory/soul-review.ts` to `src/memory/memory-review.ts`.
3. Inside these files, globally replace "SoulKeeper" with "MemoryKeeper" and "SoulReviewer" with "MemoryReviewer". Change paths from `soul.md` to `memory.md`.
4. Update `src/index.ts` and `src/trading-loop.ts` to load the renamed modules.
5. Create `data/soul.md` (static) with the core identity if it doesn't exist.
6. Commit changes.

## Task 2: Implement Backup in MemoryKeeper (TDD)
1. Add a `backupHistory()` method to `MemoryKeeper` in `src/memory/memory-keeper.ts`.
2. This method should read the current `memory.md` (if it exists) and copy it to `docs/deepresult/memory_history/memory_YYYY-MM-DDTHH-mm-ss.md`. Ensure the target directory exists.
3. Update `MemoryKeeper`'s default template to remove the "Identity" section (since that lives in `soul.md` now).
4. Commit changes.

## Task 3: Refactor MemoryReviewAgent
1. Modify `src/memory/memory-review.ts` `SOUL_REVIEW_SYSTEM` prompt: Remove the instructions to write the "identity" JSON field. It should only output "learned", "failures", and "regime".
2. In the `review()` method, before calling `this.soulKeeper.writeNarrativeSections(sections);`, add a call to `this.soulKeeper.backupHistory()`.
3. Commit changes.

## Task 4: Update Trading Loop and Prompts
1. In `src/trading-loop.ts`, read `data/soul.md` directly using `fs.readFileSync` (or similar) into a `staticSoul` variable once at the top of the loop or in `init()`.
2. Update `EnrichedPromptData` in `src/llm/prompts.ts` to accept `staticSoul?: string` and rename `soulContent` to `memoryContent?: string`.
3. Update `buildUserPrompt` in `src/llm/prompts.ts` to inject both `staticSoul` and `memoryContent`.
4. Run `npx vitest run tests/` to verify tests pass.
5. Commit changes.
