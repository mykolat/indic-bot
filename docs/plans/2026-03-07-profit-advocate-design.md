# Profit Advocate (DA) — Reactive Grok-Powered Persona

**Date:** 2026-03-07
**Status:** Approved

## Problem

DA runs in parallel with other personas in round 1 — cannot see their votes, always fires regardless of context. Prompt is too shallow (one sentence).

## Design

### Activation Logic

DA is removed from `allPersonas` parallel call. After round 1 `Promise.allSettled([RM, MS, NE])`, votes are checked:

| Condition | DA | Behavior |
|-----------|-----|----------|
| Exactly 1 action (LONG/SHORT), no second action | activate | Supports the action, finds additional catalysts |
| CLOSE without action | activate | Argues against closing, find reasons to hold |
| CLOSE + action | activate | Supports action, argues against CLOSE |
| 2+ actions or all HOLD | skip | Not needed |

DA runs once after round 1 only. Does not participate in subsequent rounds.

### Grok Search

DA always uses Grok with `{ search: true }` (web_search + x_search tools via `/v1/responses`).

Search strategy:
1. Pair-specific: `"{PAIR} price momentum catalyst breakout"`
2. Broad crypto: `"crypto market sentiment whale activity funding rates"`

Both covered by Grok's built-in web + X search in a single call.

### Prompt

Tone: Aggressive trader. Finds opportunity where others see risk. Never votes HOLD.

```
PROFIT ADVOCATE (DA): You are an aggressive trader who ALWAYS finds reasons to trade.
You see opportunity where others see risk. You NEVER vote HOLD.

YOUR STANCE:
- If others vote LONG/SHORT: amplify their case. Find additional catalysts,
  momentum signals, whale activity that supports the trade.
- If others vote CLOSE: argue AGAINST closing. The position still has potential.
  Find reasons to hold or even add to the position.

TONE: Confident, urgent. "This is THE opportunity everyone is missing.
Market hasn't priced this in yet. Enter NOW before it's too late."

RULES:
- Arguments MUST be backed by real data from your search results
- No fabricated catalysts — only cite what you actually found
- Push for higher leverage and larger size than others suggest
- Acknowledge risks briefly but immediately counter them
```

### Judge Rules (updated)

- DA has normal weight, judge may add +0.1 bonus
- If DA and RM both agree on direction -> high confidence signal
- DA arguments against CLOSE — judge weighs against risk manager

### Code Changes

| File | Change |
|------|--------|
| `src/llm/swarm-agent.ts` | Remove DA from `allPersonas`. After round 1 `Promise.allSettled`, check `shouldActivateDA(votes)`. If true, call Grok with DA prompt. Merge DA update into blackboard before judge. |
| `src/llm/blackboard-prompts.ts` | New `buildDAPrompt(boardState, otherVotes)`. Updated judge rules for DA weight. |

### New Functions

- `shouldActivateDA(votes: Record<string, Vote>)` — activation logic per table above
- `buildDAPrompt(boardState, otherVotes)` — full DA prompt with search context and other personas' votes
