# Prompt Token Optimization v1

## Problem
~2.16M tokens/6h. NewsExpert duplicates already-processed news. Brain prompt carries ~4,900 wasted tokens/cycle. LLM picks 1-2x leverage on $33 positions = $3 profit per trade.

## Changes

### 1. Remove NewsExpert from Layer 1
- **File:** `src/llm/agents.ts` — remove NewsExpert call, keep Macro + Memory
- **File:** `src/llm/prompts.ts` line 282 — remove `News Expert:` from Expert Reports section
- **Saving:** ~332k tok/6h (122k out + 210k in)

### 2. Move SOUL.md to system prompt
- **File:** `src/llm/prompts.ts` — remove `## Original System Soul` block from `buildEnrichedPrompt()` (lines 266-268)
- **File:** `src/llm/prompts.ts` — append `staticSoul` parameter to `buildSystemPrompt()`, caller passes it
- **Saving:** ~500 tok/cycle (system prompt is cached by provider, user prompt is not)

### 3. Compact TA for idle pairs
- **Criteria:** vol ratio < 1.0 AND no open position on pair
- **Full format:** ~540 tok/pair (15 lines: RSI, EMA, MACD, Bollinger, VWAP, funding history, order book, 10 closes, OHLCV)
- **Compact format:** ~60 tok/pair (1 line: price, trend, RSI, vol, VWAP delta, funding/OI summary)
- **File:** `src/llm/prompts.ts` — add `isCompactCandidate()` check in TA loop (line 320), compact renderer
- **Saving:** ~2,000-3,800 tok/cycle depending on market activity

### 4. Min leverage 5x + config
- **File:** `config.yaml` — add `minLeverage: 5`
- **File:** `src/config.ts` — read `minLeverage` from config
- **File:** `src/risk/manager.ts` — floor `decision.leverage` to `minLeverage` (bump up, not reject)
- **File:** `src/llm/prompts.ts` — add hint: `"Minimum leverage: ${config.minLeverage}x. Low balance demands capital efficiency."`
- **Effect:** $33 x 5x = $165 notional, TP 5% = $8.25 (was $3.30 at 2x)

## Implementation Tasks

### Task 1: Remove NewsExpert
1. Edit `src/llm/agents.ts`: remove NewsExpert call from `runLayer1Experts()`, update `Layer1Outputs` to drop `newsReport`
2. Edit `src/llm/prompts.ts`: remove `News Expert:\n` line from Expert Reports section
3. Edit `src/trading-loop.ts` if it references `newsReport` anywhere besides passing to prompt
4. Run `npx vitest run tests/` — fix any type errors
5. Verify: grep for `newsReport` — should only exist in test mocks if any

### Task 2: SOUL.md to system prompt
1. Edit `buildSystemPrompt()` in `src/llm/prompts.ts`: add optional `staticSoul?: string` to config, append to end of system prompt
2. Remove lines 266-268 (`## Original System Soul` block) from `buildEnrichedPrompt()`
3. Edit caller in `src/trading-loop.ts` to pass `staticSoul` to `buildSystemPrompt()` instead of `buildEnrichedPrompt()`
4. Run tests

### Task 3: Compact TA
1. Add helper `isCompactCandidate(pair, indicators, portfolio)` in `src/llm/prompts.ts`
2. Add `buildCompactTA(pair, snap, ind, ind4h)` returning 1-line summary
3. In `buildEnrichedPrompt()` TA loop: check `isCompactCandidate()`, use compact or full format
4. Run tests

### Task 4: Min leverage 5x
1. Add `minLeverage: 5` to `config.yaml`
2. Edit `src/config.ts`: read `trading.minLeverage` with default 1
3. Edit `src/risk/manager.ts`: in `validate()`, if `decision.leverage < minLeverage` → set to minLeverage (log warning)
4. Edit `src/llm/prompts.ts`: add min leverage hint to system prompt
5. Run tests, especially `tests/risk/manager.test.ts`

## Total Saving
~500-600k tokens/6h (~25-30% reduction) + doubled notional per trade
