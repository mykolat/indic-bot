# Indic — AI Crypto Futures Trading Bot

Autonomous trading bot for Binance USDS-M Futures. Uses GPT (via ChatGPT Codex API) to analyze technical indicators, news sentiment, and portfolio state, then executes LONG/SHORT/CLOSE decisions every 60 seconds.

Built to run on real money with a self-healing audit loop: `npm run audit:debug` outputs structured JSON that Claude reads, diagnoses issues, and fixes — updating config, memory, and code.

---

## Quick Start

```bash
# 1. Install deps
npm install

# 2. Configure secrets
cp .env.example .env
# Fill in: BINANCE_API_KEY, BINANCE_API_SECRET, OPENAI_MODEL

# 3. Configure trading parameters
cp config.example.yaml config.yaml
# Edit config.yaml — leverage, pairs, risk limits, cooldowns

# 4. Run (dev)
npm run dev

# 5. Run autonomous (pm2)
pm2 start "npm run dev" --name indic-bot

# 6. Audit
npm run audit          # human-readable tables
npm run audit:debug    # structured JSON for AI analysis
```

---

## Configuration

Two files, two purposes:

### `.env` — secrets only (never committed)

```env
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=true

# LLM (uses OAuth by default, or provide key)
OPENAI_MODEL=gpt-5.3-codex
# OPENAI_API_KEY=sk-...

# Optional news feed
APIFY_API_TOKEN=
```

### `config.yaml` — all trading parameters (AI-writable)

```yaml
binance:
  testnet: true

trading:
  pairs: [BTCUSDT, ETHUSDT, SOLUSDT]
  maxLeverage: 20
  maxPositionPct: 50       # max % of balance per position
  maxExposurePct: 150      # max total margin exposure %
  maxStopLossPct: 5        # SL must be within this % of entry
  maxLossUsd: 5            # fallback fixed loss cap (if maxLossPct=0)
  maxLossPct: 10           # dynamic loss cap as % of balance
  churnCooldownMs: 900000  # 15min re-entry block after close
  loopIntervalMs: 60000    # cycle interval
  targetReturnPct: 100
  minTakeProfitPct: 5
  newsRefreshIntervalH: 12
  newsMaxItems: 100
```

> `config.yaml` is versioned and editable by Claude during audits. `.env` is gitignored and never read by AI.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start bot (tsx) |
| `npm run build` | Compile TypeScript |
| `npm run test` | Run all tests |
| `npm run audit` | Human-readable snapshot |
| `npm run audit:debug` | JSON snapshot for AI analysis |
| `pm2 start indic-bot` | Start autonomous bot |
| `pm2 stop indic-bot` | Stop bot |
| `pm2 restart indic-bot` | Restart (picks up config.yaml changes) |
| `pm2 logs indic-bot` | Live logs |
| `pm2 flush indic-bot` | Clear pm2 logs |

---

## Architecture

```
src/
├── index.ts              Entry point, wires all components
├── config.ts             Loads secrets from .env + params from config.yaml
├── trading-loop.ts       Main loop: fetch → analyze → validate → execute
│
├── binance/
│   ├── client.ts         Binance SDK wrapper (USDS-M Futures)
│   ├── market-data.ts    Candles, mark price, OI, portfolio state
│   └── orders.ts         LONG/SHORT/CLOSE execution (MARKET + SL + TP)
│
├── llm/
│   ├── client.ts         ChatGPT Codex API (SSE streaming) + call() for analyst
│   ├── prompts.ts        System prompt + structured news analysis section
│   └── oauth.ts          OpenAI OAuth token refresh
│
├── risk/
│   └── manager.ts        Validates decisions: leverage, exposure, stop-loss, max loss
│
├── indicators/
│   └── technical.ts      RSI(14), EMA(20/50), ATR(14)
│
├── news/
│   ├── cryptopanic.ts    CryptoPanic headlines via Apify (configurable limit)
│   ├── news-cache.ts     File cache (~/.indic-bot/news-cache.json), 2x/day refresh
│   ├── news-analyst.ts   Separate LLM call → structured signals (importance 1-10)
│   ├── fear-greed.ts     Fear & Greed Index
│   └── types.ts
│
├── memory/
│   └── session.ts        Persists session notes + recent trades (~/.indic-bot/memory.json)
│
├── logger/
│   └── index.ts          JSONL logs: decisions, trades, errors, performance
│
└── webhook/
    ├── server.ts          Express webhook for TradingView signals
    └── signal-buffer.ts   In-memory signal queue

scripts/
├── audit.ts              Audit script (human + debug JSON modes)
└── audit-helpers.ts      Session detection, metrics, issues (testable)
```

---

## Data Flow

```
Every 60s:
  Binance API → candles (1h/4h) + mark price + OI + balance + positions
  Technical indicators: RSI(14), EMA(20/50), ATR(14)
  News cache: if stale → Apify fetch (100 items) → NewsAnalystAgent → structured signals
  Fear & Greed Index
  Session memory: prior notes + last 5 trades
        ↓
  GPT (ChatGPT Codex) → JSON decisions [{pair, action, size_pct, leverage, ...}]
        ↓
  FETCH_NEWS? → trigger on-demand news refresh, skip to next cycle
  HOLD? → skip
  Churn cooldown check → skip if pair closed within churnCooldownMs
        ↓
  RiskManager.validate() → approve / reject / shutdown
        ↓
  OrderExecutor → LONG/SHORT: MARKET + STOP_MARKET + TAKE_PROFIT_MARKET
                  CLOSE: MARKET reduceOnly
        ↓
  Logger → decisions.jsonl, trades.jsonl, errors.jsonl, performance.jsonl
```

---

## Risk Management

`RiskManager.validate()` checks before every trade:

1. Session PnL ≤ `-maxLossPct% × balance` (or `-maxLossUsd` if pct=0) → **shutdown**
2. Leverage > `maxLeverage` → reject
3. Position size > `maxPositionPct` → reject
4. Stop-loss missing or > `maxStopLossPct` → reject
5. Total margin exposure > `maxExposurePct` → reject
6. `FETCH_NEWS` and `HOLD` → pass through without validation

---

## Order Execution

Every LONG/SHORT places **3 orders atomically**:

```
1. MARKET order (entry)
2. STOP_MARKET (stop-loss, reduceOnly)
3. TAKE_PROFIT_MARKET (take-profit, reduceOnly)
```

CLOSE uses MARKET reduceOnly with exact position size from Binance API.

---

## Anti-Churn

After any CLOSE, the pair is blocked for `churnCooldownMs` (default 15min). Blocked attempts are logged as `CHURN_BLOCK` in `decisions.jsonl` and visible in audit output.

---

## News Intelligence

- **Cache**: `~/.indic-bot/news-cache.json` — refreshed every `newsRefreshIntervalH` hours (default 12)
- **Analyst**: separate LLM call classifies 100 headlines into structured signals (direction, importance 1-10, catalyst, timeframe)
- **Trading LLM receives**: sentiment + summary + top signals — not raw headlines
- **On-demand**: LLM can request `FETCH_NEWS` action to trigger immediate refresh
- **History**: `~/.indic-bot/news-history.jsonl` — all fetches for correlation analysis

---

## Strategy (LLM-driven)

System prompt instructs the LLM to follow these rules (overridable with reasoning):

- **Trend-following**: LONG if EMA20 > EMA50, SHORT if EMA20 < EMA50
- **Momentum entry**: RSI 40–65 for LONG, 35–60 for SHORT
- **Funding arbitrage**: extreme negative funding → lean LONG
- **Exit (time)**: held > 4h with no progress and P&L < -2.5% → CLOSE
- **Exit (RSI)**: RSI > 78 on active LONG / RSI < 22 on active SHORT → consider CLOSE
- **No scalping**: minimum take-profit `minTakeProfitPct`%

---

## AI Audit Loop

```
npm run audit:debug
  → structured JSON: account, positions, session metrics,
    realized PnL, churn blocks, issues detected, config

Claude reads JSON → diagnoses:
  - winrate, avg PnL/trade
  - churn patterns → increase churnCooldownMs in config.yaml
  - code bugs → fix src/**
  - insights → update ~/.indic-bot/memory.json

pm2 restart indic-bot  ← picks up config.yaml changes
```

---

## Logs

All logs in `logs/` as JSONL (one JSON object per line):

| File | Contents |
|------|----------|
| `decisions.jsonl` | Every LLM decision + risk rejections + churn blocks |
| `trades.jsonl` | Executed LONG/SHORT/CLOSE orders |
| `errors.jsonl` | Order failures, loop errors |
| `performance.jsonl` | Balance + open positions per cycle |

---

## Security

- **`.env` is never read directly in code** — only via `loadConfig()`
- **`config.yaml` contains no secrets** — safe to commit and AI-editable
- **API keys are never logged** — Logger writes only trade/decision data
- **LLM has no access to config or env** — prompts contain only market data, portfolio state, news signals
- **`.env` is in `.gitignore`** — never committed

---

## Tests

```bash
npm test                             # all tests (~59)
npx vitest run tests/risk/           # risk manager only
npx vitest run tests/binance/        # order executor only
npx vitest run tests/news/           # news cache + analyst
npx vitest run tests/audit-helpers.test.ts
```

Tests cover: risk manager, order executor, LLM client, trading loop, market data, news cache, news analyst, audit helpers.
