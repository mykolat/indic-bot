# Session-Aware Market Context for Indicbot

**Date:** 2026-03-07
**Status:** Draft
**Principle:** Market session is a weak contextual prior, not a trading rule.

## 1. Goal

Add a session-aware context layer that:
- Identifies the current market session by UTC
- Passes it to the LLM as a **weak prior**, not a hard rule
- Requires the LLM to explicitly confirm or reject the typical session pattern based on real market data
- Does NOT replace the regime classifier
- Does NOT introduce session-based guardrails
- Does NOT force regimes (e.g. "Asia => Scalping")

**One-liner:** The bot knows what session it is, but trades the real market, not the schedule.

## 2. Product Idea

Session works as a contextual hint:
- "It's Asia Dead Zone, typical pattern: lower participation / weaker trends"
- But the LLM must separately assess:
  - Whether the session pattern is confirmed
  - Whether the session pattern is inactive
  - Whether the market is behaving against the usual session pattern

Examples:
- Asia + volume spike + news + breakout -> not a dead zone
- London Open + volume dry + no follow-through -> not a directional session
- NY Close + capitulation + liquidation cascade -> active stress regime

## 3. What NOT To Do

Do NOT:
- Hard override regime by session
- Force session-based leverage caps
- Force session-based confidence thresholds
- Write "I lose money in Asia, stay cautious" as soul doctrine
- Use session as behavioral override
- Treat session as pseudo-astrology

Do NOT change (this task):
- RiskManager core logic
- regime-classifier scoring
- Execution layer
- Exposure model

## 4. Implementation

### 4.1. Session Detector

New module: `src/market/session.ts`

```ts
type MarketSession =
  | "asia_dead_zone"        // 00:00-06:00 UTC
  | "london_open"           // 06:00-10:00 UTC
  | "london_continuation"   // 10:00-13:00 UTC (transition/neutral)
  | "london_ny_overlap"     // 13:00-17:00 UTC
  | "ny_session"            // 17:00-21:00 UTC
  | "ny_close_evening";     // 21:00-00:00 UTC

function getMarketSession(nowUtc: Date): MarketSession
```

### 4.2. Session Metadata

Dictionary of session descriptions for the prompt. Per session:
- `name` — human-readable name
- `utcRange` — time range string
- `typicalTendencies` — array of neutral observations
- `cautions` — what NOT to assume
- `confirmationSignals` — market data that confirms the pattern
- `rejectionSignals` — market data that invalidates the pattern

Example:
```ts
asia_dead_zone: {
  name: "Asia Dead Zone",
  utcRange: "00:00-06:00 UTC",
  typicalTendencies: [
    "lower participation",
    "weaker directional conviction",
    "more range behavior"
  ],
  cautions: [
    "do not assume dead zone if volume or event activity is elevated"
  ],
  confirmationSignals: [
    "subdued volume",
    "weak follow-through",
    "low ADX"
  ],
  rejectionSignals: [
    "volume expansion",
    "strong news catalyst",
    "breakout structure",
    "liquidation activity"
  ]
}
```

### 4.3. Prompt Injection

New block in `buildEnrichedPrompt()`:

```
=== CURRENT MARKET SESSION ===
Session: Asia Dead Zone (00:00-06:00 UTC)

Typical tendencies:
- lower participation
- weaker trend reliability
- more range behavior

Important:
Treat this as a weak prior, not as a rule.
Do not assume the session pattern is active unless market data confirms it.

You must explicitly assess:
1. Is the session pattern confirmed by current market conditions?
2. Is the market behaving against the usual session pattern?
3. Should session context matter for this decision, or be ignored?
```

Language must be **neutral** — no "dead zone", "most reliable", "full leverage available". Only factual tendencies with explicit confirmation/rejection requirement.

### 4.4. New LLM Output Fields

Add to decision schema:

```ts
session_context: {
  session: MarketSession;
  session_pattern_active: boolean;
  session_fit_score: number;        // 0-100
  session_role: "supports" | "neutral" | "contradicts";
  session_reason: string;
}
```

The LLM must not just "see" the session — it must evaluate whether the session is relevant right now.

### 4.5. Journal / Observability

Log in decision journal:
- `session`
- `session_pattern_active`
- `session_fit_score`
- `session_role`
- `session_reason`

Example journal entry:
```
Session: Asia Dead Zone
Session fit: 18/100
Role: contradicts
Reason: elevated volume, bearish multi-timeframe alignment, and news-driven
momentum invalidate the usual low-activity Asia profile
```

### 4.6. Session-Aware nextCheckMinutes

LLM can use session context for `nextCheckMinutes`, but not automatically.

- Session can influence cadence, but only if confirmed by market
- Asia + weak market = 20-30 min
- Asia + active breakout = 5-10 min
- Overlap + low activity = not necessarily 5 min
- Overlap + real expansion = 5 min

### 4.7. DB Storage

Add `session` and `session_context` fields to `trade_decisions` table (or new column in `cycles`).

Minimum to persist:
- session at entry
- session_fit_score
- session_role
- outcome PnL
- action type
- regime

## 5. Interaction with Regime Classifier

**session != regime**

- Regime classifier remains independent, driven by indicators
- Session goes to LLM as contextual prior
- LLM can produce: regime=Breakout, session=Asia Dead Zone, session_role=contradicts
- Valid combinations: "Asia but breakout", "London but no edge", "NY Close but capitulation"

## 6. Analytics / Attribution (Future)

Collect data for future analysis, but do NOT feed back into soul/memory as doctrine.

Future queries:
- PnL by session
- PnL by regime x session
- Whether LLM correctly assesses session relevance
- Win rate when session_role=contradicts vs supports

## 7. Acceptance Criteria

**Functional:**
- Bot identifies current session by UTC
- Session context added to prompt
- LLM explicitly assesses whether session pattern is active
- Session does not force regime
- Session does not introduce hardcoded behavior

**Quality:**
- In Asia, valid breakout/trend decisions are possible
- In London/NY, HOLD/WAIT without forcing trades is possible
- Journal shows why session was considered or ignored

**Negative cases (must pass):**
- Asia + high volume + news + breakout -> session rejected, trade allowed
- London Open + low volume + mixed signals -> session neutral/ignored
- NY Close + liquidation stress -> session contradicted by live market

## 8. Out of Scope

- Per-session learning into memory persona
- Session-based leverage rules
- Session-based hard filters
- Changes to RiskManager
- Changes to classifier thresholds
- Separate session agent
- Separate Grok session analyzer

## 9. Files to Create/Modify

| File | Action |
|---|---|
| `src/market/session.ts` | **Create** — getMarketSession() + metadata |
| `src/llm/prompts.ts` | **Modify** — add session block to buildEnrichedPrompt() |
| `src/llm/cot-schema.ts` | **Modify** — add session_context to decision schema |
| `src/trading-loop.ts` | **Modify** — call getMarketSession(), pass to prompt, log to journal |
| `src/logging/decision-journal.ts` | **Modify** — log session fields |
| `src/db/repository.ts` | **Modify** — persist session context |
| `src/db/types.ts` | **Modify** — add session types |
| `tests/market/session.test.ts` | **Create** — unit tests for session detector |
