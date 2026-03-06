# Dual-Channel Swarm Communication — Design Doc

## Goal

Run every swarm debate twice in parallel — Human-Readable (prose) and AI-Readable (structured JSON protocol) — to measure token savings, latency reduction, and decision divergence. Proves whether LLM-to-LLM communication can bypass human language without sacrificing decision quality.

## Hypothesis

LLM agents communicating in a machine-optimized JSON protocol can reach equivalent trading decisions at 3-10x fewer tokens and 15-40% lower latency compared to human-readable prose debates.

## Architecture

```
Market Data + Portfolio
        |
        ├── Channel H (Human-Readable) ──→ prose debate ──→ decisions_h
        |                                                        |
        └── Channel A (AI-Readable) ──────→ JSON debate ──→ decisions_a
                                                                 |
                                                          ┌──────┴──────┐
                                                          │  COMPARE    │
                                                          │ tokens, lat │
                                                          │ decisions   │
                                                          └─────────────┘
```

Both channels run via `Promise.all` — same input data, same personas, different prompts.
Channel H = production (decisions used). Channel A = experiment only.

## AI-Readable Protocol

### Persona message (Level 1)

```json
{
  "p": "RM",
  "d": "HOLD",
  "prob": 30,
  "c": 90,
  "thesis": "liq_cascade_risk_97k",
  "args": ["funding_0.03", "oi_ath", "fg_18"],
  "risks": ["short_squeeze_if_crowded"],
  "ctx": "4h_bear_ema_below"
}
```

### Persona message (Level 2+ — with contra)

```json
{
  "p": "DA",
  "d": "LONG",
  "prob": 55,
  "c": 70,
  "thesis": "crowded_short_unwind",
  "contra": [
    "RM.risks.liq_cascade→unlikely_funding_neutral",
    "BA.thesis→anchoring_bias_single_candle"
  ]
}
```

### Judge message

```json
{
  "continue": false,
  "verdict": "consensus_hold_low_edge",
  "decisions": [{"pair": "BTCUSDT", "d": "HOLD", "c": 45}]
}
```

### Field reference

| Field | Type | Meaning |
|-------|------|---------|
| p | string | Persona short code (RM, BT, BA, MS, DA, NE) |
| d | string | Decision: HOLD/LONG/SHORT/CLOSE |
| prob | int | probability_of_success 0-100 |
| c | int | confidence 0-100 |
| thesis | string | Core thesis as slug/short phrase |
| args | string[] | Supporting arguments as compact tags |
| risks | string[] | Key risks as compact tags |
| ctx | string | Market context summary |
| contra | string[] | Cross-references to other personas' arguments |

## DB Schema

### Table: `swarm_experiments`

```sql
CREATE TABLE swarm_experiments (
  id SERIAL PRIMARY KEY,
  cycle_id INT REFERENCES cycles(id),
  channel TEXT NOT NULL CHECK (channel IN ('human', 'ai')),
  persona TEXT NOT NULL,
  phase INT DEFAULT 1,
  raw_response TEXT,
  tokens_in INT,
  tokens_out INT,
  latency_ms INT,
  decision TEXT,
  confidence INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_swarm_exp_cycle ON swarm_experiments(cycle_id);
CREATE INDEX idx_swarm_exp_channel ON swarm_experiments(channel);
```

### Table: `swarm_experiment_results`

```sql
CREATE TABLE swarm_experiment_results (
  id SERIAL PRIMARY KEY,
  cycle_id INT UNIQUE REFERENCES cycles(id),
  human_decision TEXT,
  ai_decision TEXT,
  same_decision BOOLEAN,
  human_tokens INT,
  ai_tokens INT,
  compression_ratio FLOAT,
  human_latency_ms INT,
  ai_latency_ms INT,
  human_levels INT,
  ai_levels INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## UI Components

### Toggle in Swarm chat

```
[ Human ] [ AI ]
```

Switches between channels for the selected debate. Human mode shows chat bubbles (existing). AI mode shows formatted JSON cards.

### Token VS Widget

Below the chat area:

```
Human: 1,247 tokens  ███████████████
AI:      189 tokens  ███
Savings: 84.8% | Same decision: YES ✅
```

### Experiment Dashboard (on LLM Costs page)

Aggregate stats:
- Average compression ratio
- Decision agreement rate
- Token savings per day
- Latency comparison chart

## Dependency

This plan builds ON TOP of `docs/plans/2026-03-07-swarm-chat-plan.md` (10 tasks).
Execute after the swarm chat redesign is complete.

## Migration Strategy

- Phase 1 (now): Human = production, AI = experiment
- Phase 2 (after data): If agreement > 80%, switch AI to primary, Human to debug layer
