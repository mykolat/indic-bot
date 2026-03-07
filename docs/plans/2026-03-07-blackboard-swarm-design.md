# Blackboard Swarm — Design Doc

## Goal

Replace the sequential message-based swarm debate with a Blackboard Pattern: a shared state object that all personas read from and write to simultaneously. This reduces LLM calls by 60-80% while maintaining (or improving) decision quality. The UI remains a beautiful messenger-style chat with animations, plus new Conflict and Blackboard State cards.

## Why Blackboard > Dual-Channel

| | Dual-Channel | Blackboard |
|---|---|---|
| LLM calls per cycle | 12-14 (6-7 x 2 channels) | 3-7 (parallel reads, only conflicts re-run) |
| Token savings source | Output format only (10-20% real) | Fewer calls + no context repetition (60-80%) |
| Decision quality | AI-channel may be worse (lossy) | Same or better (shared state = full visibility) |
| Complexity | Two parallel pipelines | One simpler pipeline |

## Architecture

```
Market Data + Portfolio
        |
        v
  [BLACKBOARD] ← shared state
        |
   Round 1: ALL personas read board → write updates → merge
        |
        v
  Judge reads board → identifies conflicts → continue?
        |
   Round 2: ONLY conflicting personas → update → merge
        |
        v
  Judge reads board → final decision (max 3 rounds)
```

## Blackboard Data Structure

```typescript
interface SwarmBlackboard {
  market: {
    pairs: string[];
    regime: string;
    fearGreed: number;
    volumeRatio: number;
    keyLevels: string[];   // e.g. "BTC_support_95k", "BTC_resistance_100k"
  };
  signals: {
    bullish: string[];     // compact tags: "ema200_bounce", "rsi_oversold_28"
    bearish: string[];     // "funding_0.03", "oi_ath", "fg_18"
    neutral: string[];     // "volume_avg", "ls_ratio_balanced"
  };
  votes: Record<string, {
    d: string;             // HOLD | LONG | SHORT | CLOSE
    c: number;             // confidence 0-100
    prob: number;          // probability_of_success 0-100
    reason: string;        // compact slug
  }>;
  risks: string[];         // aggregated risk tags
  conflicts: Array<{
    between: [string, string];
    topic: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}
```

## Persona Prompt (Blackboard-aware)

```
ROLE: {persona_role}
CODE: {persona_code}

READ the BLACKBOARD and write YOUR section update.

BLACKBOARD STATE:
{json_state}

MARKET DATA:
{enriched_prompt}

OUTPUT (JSON only):
{
  "signals": { "bullish": [...], "bearish": [...], "neutral": [...] },
  "vote": { "d": "HOLD", "c": 90, "prob": 30, "reason": "slug" },
  "risks": ["risk_tag"],
  "conflicts_with": { "BT": "why_you_disagree_slug" }
}

RULES:
- Tags only, no prose. Max 5 words per tag.
- Read other votes if present. Reference them in conflicts_with.
- NO explanation. ONLY valid JSON.
```

## Judge Prompt (Blackboard-aware)

```
SWARM JUDGE. Round {n}/{max}.

BLACKBOARD:
{json_state}

RULES:
- If votes agree (3+ same direction) AND no high-severity conflicts → stop, output decision
- If high-severity conflict exists → continue, specify who speaks next
- Max 3 rounds
- Output:
{
  "continue": true|false,
  "verdict": "slug",
  "next_speakers": ["RM", "BT"],
  "decisions": [{"pair":"BTCUSDT","action":"HOLD","confidence":45,...}],
  "next_check_minutes": 15
}
```

## DB Changes

### Modify `swarm_personas`

```sql
ALTER TABLE swarm_personas ADD COLUMN IF NOT EXISTS conflicts_with JSONB;
ALTER TABLE swarm_personas ADD COLUMN IF NOT EXISTS signals JSONB;
```

### Add `blackboard_state` to `llm_conversations`

```sql
ALTER TABLE llm_conversations ADD COLUMN IF NOT EXISTS blackboard_state JSONB;
```

This stores the blackboard snapshot at each judge evaluation point.

## UI — Animations (framer-motion)

### Install

```bash
cd dashboard && npm install framer-motion
```

### Animation Spec

| Element | Animation | Duration |
|---------|-----------|----------|
| Message appear | Slide-in from left + fade (right for judge) | 0.3s, stagger 0.08s |
| ConflictCard appear | Scale 0.95->1.0 + amber glow pulse | 0.4s + infinite pulse 2s |
| BlackboardStateCard expand | Spring accordion (stiffness 300, damping 30) | ~0.3s |
| Vote dots (sidebar) | Pop: scale 0->1.2->1.0 | 0.3s, stagger 0.05s |
| LevelDivider | Line grows from center, text fades in | 0.5s |
| Superuser message | Slide-in + gold border shimmer | 0.4s |
| Sidebar item (new) | Slide-down from top | 0.3s |

### ConflictCard Component

Appears between persona messages when a conflict is detected:

```
  ┌─────────────────────────────────────┐
  │  CONFLICT  🐂 Bull vs 🐻 Bear       │
  │  Topic: direction                    │
  │  Severity: ██████████ HIGH           │
  └─────────────────────────────────────┘
```

- Amber border with subtle pulse glow
- Shows between the conflicting persona messages
- Severity bar: green/yellow/red gradient

### BlackboardStateCard Component

Collapsible card at the bottom of each round, after Judge verdict:

```
  ┌─ BLACKBOARD STATE ──────────── [v] ─┐
  │                                      │
  │  Bullish   ema200  rsi_28     2 tags │
  │  Bearish   funding  oi  fg    3 tags │
  │  Risks     liq_cascade       1 tag  │
  │                                      │
  │  Votes   🟢 BT  🔴 BA  ⚪ RM  ⚪ MS │
  │          ⚪ DA                        │
  │                                      │
  │  Result  3/5 HOLD → consensus        │
  └──────────────────────────────────────┘
```

- Collapsed by default, click to expand
- Tags as colored pills (green=bullish, red=bearish, yellow=risk)
- Animated expand with spring physics

## Migration Strategy

- **Phase 1 (now):** Chat UI + Blackboard State card (collapsible). Backend uses blackboard pattern.
- **Phase 2 (later):** Blackboard State becomes primary view. Chat becomes secondary expandable section.

## Dependencies

- Builds on existing swarm chat UI (SwarmChatMessage, DebateSidebar, LevelDivider — all exist)
- Requires framer-motion npm package
- Refactors `src/llm/swarm-agent.ts` (replaces sequential debate with blackboard loop)
