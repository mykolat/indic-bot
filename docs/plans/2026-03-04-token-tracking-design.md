# Token Tracking Fix — Design

## Problem

The Codex SSE API (`chatgpt.com/backend-api/codex/responses`) streams responses but may not return `usage` data in `response.completed` events. All 403 logged API calls show 0 tokens in/out. This prevents cost tracking and prompt optimization.

## Solution

1. **Debug logging** — log `response.completed` event structure to confirm whether usage data exists
2. **Char/4 estimation fallback** — if API doesn't provide usage, estimate: `tokens ≈ chars / 4`
3. **`estimated` flag in TokenLogger** — distinguish API-reported vs estimated counts
4. **Audit display** — show estimated marker, add prompt size stats

## Architecture

- `streamSSE()` gains `promptLength` parameter for estimation
- If `response.completed` provides `usage.input_tokens` → use native values
- If not → estimate from `promptLength / 4` (input) and `output.length / 4` (output)
- TokenLogger gets `estimated?: boolean` field
- Audit script shows `~` prefix for estimated values + avg/max prompt size

## No new dependencies. Zero impact on trading logic.
