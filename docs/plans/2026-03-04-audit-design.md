# AI Audit System Design

**Date:** 2026-03-04
**Goal:** Replace human-read audit with AI-driven self-healing loop. `npm run audit:debug` outputs structured JSON → AI (Claude) reads, diagnoses issues, updates memory/config/code.

---

## Problem

Current `npm run audit`:
- Human reads ASCII tables — no machine-readable output
- `sessionPnl` always 0 (bug)
- 24h Binance trade window crosses sessions — misleading totals
- No winrate, avg PnL, churn count
- No issues detection
- Config mixed into `.env` — AI cannot read or modify trading params

---

## Architecture

```
npm run audit        → human-readable tables (stdout)
npm run audit:debug  → full JSON (stdout) → AI reads → diagnoses → acts

AI acts on:
  ~/.indic-bot/memory.json   ← session notes for trading LLM
  config.yaml                ← trading parameters (AI-writable)
  src/**/*.ts                ← code fixes if bugs detected
```

---

## Component 1: `config.yaml`

Replaces all non-secret `.env` params. Secrets stay in `.env`.

**`.env` (secrets only, gitignored):**
```env
BINANCE_API_KEY=
BINANCE_API_SECRET=
OPENAI_API_KEY=
APIFY_API_TOKEN=
```

**`config.yaml` (versioned, AI-readable + AI-writable):**
```yaml
trading:
  pairs: [BTCUSDT, ETHUSDT, SOLUSDT]
  maxLeverage: 20
  maxPositionPct: 50
  maxExposurePct: 150
  maxStopLossPct: 5
  maxLossUsd: 5
  maxLossPct: 10
  churnCooldownMs: 900000
  loopIntervalMs: 60000
  targetReturnPct: 100
  minTakeProfitPct: 5
  newsRefreshIntervalH: 12
  newsMaxItems: 100
  binance:
    testnet: true
```

`src/config.ts` reads secrets from `process.env`, trading params from `config.yaml` (with `.env` overrides for backwards compat during migration).

---

## Component 2: Enhanced `scripts/audit.ts`

Two modes via `AUDIT_MODE=debug` env var or `--debug` arg:

### `npm run audit` (human mode)
Same ASCII tables as today, plus new sections:
- **SESSION METRICS** — winrate, avg PnL/trade, churn blocks
- **ISSUES DETECTED** — auto-detected problems

### `npm run audit:debug` (JSON mode)
Full structured JSON to stdout:

```json
{
  "generatedAt": "2026-03-04T16:30:00Z",
  "account": {
    "walletBalance": 5411.03,
    "marginBalance": 5411.03,
    "availableBalance": 5411.03,
    "unrealizedPnl": 0.00,
    "initialMargin": 0.00
  },
  "openPositions": [
    {
      "symbol": "SOLUSDT",
      "side": "LONG",
      "leverage": 20,
      "entryPrice": 142.50,
      "markPrice": 139.20,
      "margin": 270.55,
      "notional": 5411.00,
      "unrealizedPnl": -66.00,
      "unrealizedPnlPct": -24.4,
      "liquidationPrice": 135.80
    }
  ],
  "session": {
    "startedAt": "2026-03-04T16:11:00Z",
    "cycles": 12,
    "totalTrades": 3,
    "profitableTrades": 1,
    "winrate": 0.33,
    "totalRealizedPnl": -37.20,
    "avgPnlPerTrade": -12.40,
    "churnBlocks": 2,
    "riskRejections": 0
  },
  "allTimeTrades": [
    {
      "pair": "SOLUSDT",
      "action": "LONG",
      "openedAt": "2026-03-04T15:29Z",
      "closedAt": "2026-03-04T15:30Z",
      "holdMinutes": 1,
      "realizedPnl": 45.20,
      "reasoning": "EMA20>EMA50 bullish..."
    }
  ],
  "issues": [
    "sessionPnl always 0 in performance.jsonl — not tracking realized PnL",
    "SOLUSDT: 3 closes in 90min — churn pattern detected",
    "SOLUSDT LONG at 16:12 had no stop-loss order confirmed"
  ],
  "config": {
    "source": "config.yaml",
    "churnCooldownMs": 900000,
    "maxLossPct": 10,
    "maxLeverage": 20,
    "pairs": ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
  },
  "newsCache": {
    "fetchedAt": "2026-03-04T15:07Z",
    "itemCount": 52,
    "sentiment": "cautiously_bullish",
    "signalCount": 7
  },
  "memory": {
    "sessionNotes": "new insight: BTC trending up",
    "recentTradeCount": 5
  }
}
```

---

## Component 3: `/audit` Skill

Saved to `~/.claude/skills/audit.md`. Tells Claude:

1. Run `npm run audit:debug` and capture JSON output
2. Read `config.yaml`
3. Diagnose:
   - Is winrate < 40%? Look at reasoning patterns — is LLM over-trading one pair?
   - Are there ISSUES? Fix code bugs immediately
   - Churn blocks > 0 and winrate low? Increase `churnCooldownMs` in config.yaml
   - Unrealized PnL > 20% loss? Check if SL orders were placed
4. Act:
   - Update `~/.indic-bot/memory.json` session_notes with diagnosis
   - Update `config.yaml` if parameter tuning needed
   - Fix code if bugs detected
   - Commit all changes

---

## Session Detection in Logs

`performance.jsonl` entries reset on bot restart (cycleCount resets to 0). Use this to split sessions:

```typescript
// Session boundary: cycleCount goes from N → 0
// Current session = entries from last boundary to end
```

---

## `npm run audit:debug` Implementation

```typescript
// package.json
"audit": "tsx scripts/audit.ts",
"audit:debug": "AUDIT_MODE=debug tsx scripts/audit.ts"
```

```typescript
// scripts/audit.ts
const debugMode = process.env.AUDIT_MODE === 'debug';

if (debugMode) {
  console.log(JSON.stringify(buildDebugPayload(), null, 2));
} else {
  printHumanReport();
}
```

---

## Issues Detection Logic

Auto-detected in audit.ts:

| Check | Issue |
|-------|-------|
| `sessionPnl === 0` in all perf entries | Bug: realized PnL not tracked |
| Same pair closed 3+ times within 2h | Churn pattern |
| LONG/SHORT in trades but no corresponding stop order visible | Missing SL |
| `cycleCount` resets multiple times in one log file | Multiple restarts |
| Winrate < 30% over 5+ trades | Strategy underperforming |

---

## Migration Path

1. Create `config.yaml` with current defaults
2. Update `src/config.ts` to read from yaml (fallback to env vars)
3. Update `scripts/audit.ts` — add debug mode + session metrics + issues
4. Add `audit:debug` to `package.json`
5. Create `/audit` skill file
6. Fix `sessionPnl` bug in `src/trading-loop.ts`
