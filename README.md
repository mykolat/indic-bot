# Indic — AI Crypto Futures Trading Bot

Autonomous trading bot for Binance USDS-M Futures. Uses GPT (via ChatGPT Codex API) to analyze technical indicators, news, and sentiment, then executes LONG/SHORT/CLOSE decisions every 60 seconds.

---

## Quick Start

```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env
# Fill in BINANCE_API_KEY, BINANCE_API_SECRET, OPENAI_MODEL

# 3. Run (dev mode)
npm run dev

# 4. Run autonomous (pm2)
pm2 start "npm run dev" --name indic-bot

# 5. Audit current state
npm run audit
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start bot (ts-node) |
| `npm run build` | Compile TypeScript |
| `npm run test` | Run all tests |
| `npm run audit` | Binance account + logs snapshot |
| `pm2 start indic-bot` | Start autonomous bot |
| `pm2 stop indic-bot` | Stop bot |
| `pm2 logs indic-bot` | Live logs |
| `pm2 flush indic-bot` | Clear pm2 logs |

---

## Architecture

```
src/
├── index.ts              Entry point, wires all components
├── config.ts             Loads .env config
├── trading-loop.ts       Main loop: fetch → analyze → validate → execute
│
├── binance/
│   ├── client.ts         Binance SDK wrapper (USDS-M Futures)
│   ├── market-data.ts    Candles, mark price, OI, portfolio state
│   └── orders.ts         LONG/SHORT/CLOSE execution
│
├── llm/
│   ├── client.ts         ChatGPT Codex API (SSE streaming)
│   ├── prompts.ts        System prompt + user prompt builder
│   └── oauth.ts          OpenAI OAuth token refresh
│
├── risk/
│   └── manager.ts        Validates decisions: leverage, exposure, stop-loss, max loss
│
├── indicators/
│   └── technical.ts      RSI(14), EMA(20/50), ATR(14)
│
├── news/
│   ├── cryptopanic.ts    CryptoPanic headlines via Apify
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
```

---

## Data Flow

```
Every 60s:
  Binance API → candles (1h/4h) + mark price + OI + balance + positions
  Technical indicators: RSI, EMA20/50, ATR
  News: CryptoPanic + Fear & Greed Index
  Session memory: prior notes + last 5 trades
        ↓
  GPT (ChatGPT Codex) → JSON decisions [{pair, action, size_pct, leverage, ...}]
        ↓
  RiskManager.validate() → approve / reject / shutdown
        ↓
  OrderExecutor → LONG (market + stop-loss) / SHORT / CLOSE
        ↓
  Logger → decisions.jsonl, trades.jsonl, errors.jsonl, performance.jsonl
```

---

## Configuration (.env)

```env
# Required
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=true

# LLM
OPENAI_MODEL=gpt-5.3-codex
# OPENAI_API_KEY=sk-...   (optional, uses OAuth by default)

# Optional
APIFY_API_TOKEN=           # CryptoPanic news via Apify
TRADING_PAIRS=BTCUSDT,ETHUSDT,SOLUSDT
LOOP_INTERVAL_MS=60000

# Risk limits
MAX_LEVERAGE=20
MAX_POSITION_PCT=50
MAX_EXPOSURE_PCT=150
MAX_STOP_LOSS_PCT=5
MAX_LOSS_USD=5

# Strategy targets
TARGET_RETURN_PCT=100
MIN_TAKE_PROFIT_PCT=5
```

---

## Logs

All logs in `logs/` as JSONL (one JSON object per line):

| File | Contents |
|------|----------|
| `decisions.jsonl` | Every LLM decision + risk rejections |
| `trades.jsonl` | Executed LONG/SHORT/CLOSE orders |
| `errors.jsonl` | Order failures, loop errors |
| `performance.jsonl` | Balance + open positions per cycle |

---

## Risk Management

`RiskManager.validate()` checks before every trade:
1. Session PnL ≤ `-MAX_LOSS_USD` → shutdown
2. Leverage > `MAX_LEVERAGE` → reject
3. Position size > `MAX_POSITION_PCT` → reject
4. Stop-loss missing or > `MAX_STOP_LOSS_PCT` → reject
5. Total margin exposure > `MAX_EXPOSURE_PCT` → reject

---

## Strategy (LLM-driven)

The system prompt instructs the LLM to follow these rules (overridable with reasoning):

- **Trend-following**: LONG if EMA20 > EMA50, SHORT if EMA20 < EMA50
- **Momentum entry**: RSI 40–65 for LONG, 35–60 for SHORT
- **Funding arbitrage**: extreme negative funding → lean LONG
- **Exit**: held > 4h with no progress and P&L < -2.5% → CLOSE
- **Exit**: RSI > 78 on active LONG / RSI < 22 on active SHORT → consider CLOSE
- **No scalping**: minimum take-profit `MIN_TAKE_PROFIT_PCT`%

---

## Security Rules

- **`.env` is never read directly in code** — only via `process.env` through `loadConfig()`
- **API keys are never logged** — `Logger` writes only trade/decision data, no credentials
- **LLM has no access to config or env** — prompts contain only market data, portfolio state, news. No file paths, no API keys, no system info
- **`.env` is in `.gitignore`** — never committed
- **Audit script reads config via `loadConfig()`** — same rule, no raw `process.env` access outside config module

---

## Tests

```bash
npm test                          # all tests
npx vitest run tests/risk/        # risk manager only
npx vitest run tests/binance/     # order executor only
```

36 tests covering: risk manager, order executor, LLM client, trading loop, market data.
