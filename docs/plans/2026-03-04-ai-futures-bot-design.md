# AI Futures Trading Bot — MVP Design

## Overview

An autonomous AI-powered futures trading bot for Binance that uses GPT 5.3 to analyze market data and TradingView signals, making trading decisions for BTC, ETH, and SOL perpetual futures.

## Requirements

| Parameter | Value |
|-----------|-------|
| Type | MVP, overnight test with $10 |
| Language | TypeScript / Node.js |
| LLM | OpenAI GPT 5.3 via OAuth (openclaw approach) |
| Pairs | BTCUSDT, ETHUSDT, SOLUSDT futures |
| Leverage | Up to 10x |
| Approach | LLM as primary analyst + TradingView signals as supplementary data |
| Data sources | OHLCV, funding rate, open interest, TradingView webhooks |
| Logging | Mandatory — all decisions, trades, and errors in JSONL |
| Testing | TDD — tests first for every module |

## Architecture: Monolith Loop

Single Node.js process with an Express webhook receiver and a 5-minute trading loop.

```
┌──────────────────────────────────────────────────┐
│                  Node.js Process                  │
│                                                   │
│  ┌─────────────┐     ┌──────────────────────┐    │
│  │  Express     │◄────│  TradingView Alerts   │    │
│  │  :3000       │     │  (webhook POST)       │    │
│  └──────┬───────┘     └──────────────────────┘    │
│         │ stores in SignalBuffer                   │
│         ▼                                         │
│  ┌──────────────────────────────────────────┐    │
│  │           Main Trading Loop               │    │
│  │           (every 5 minutes)               │    │
│  │                                           │    │
│  │  1. Binance API → OHLCV, funding, OI     │    │
│  │  2. SignalBuffer → recent TV signals      │    │
│  │  3. GPT 5.3 → analysis + decision        │    │
│  │  4. Risk Manager → validate limits        │    │
│  │  5. Binance API → execute order           │    │
│  │  6. Logger → record everything            │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │           Logger (file + console)         │    │
│  │  logs/trades.jsonl — all trades           │    │
│  │  logs/decisions.jsonl — LLM decisions     │    │
│  │  logs/errors.jsonl — errors               │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

## File Structure

```
04_Indic/
├── src/
│   ├── index.ts              # Entry point: starts loop + Express
│   ├── config.ts             # ENV vars, trading params
│   ├── trading-loop.ts       # Main loop logic (every 5 min)
│   ├── llm/
│   │   ├── client.ts         # OpenAI GPT 5.3 OAuth client
│   │   └── prompts.ts        # System/user prompts for analysis
│   ├── binance/
│   │   ├── client.ts         # Binance Futures API wrapper
│   │   ├── market-data.ts    # OHLCV, funding rate, OI fetchers
│   │   └── orders.ts         # Place/close orders
│   ├── webhook/
│   │   ├── server.ts         # Express webhook receiver
│   │   └── signal-buffer.ts  # Buffer for TradingView signals
│   ├── risk/
│   │   └── manager.ts        # Position sizing, stop-loss, max exposure
│   └── logger/
│       └── index.ts          # JSONL file logger + console
├── tests/
│   ├── trading-loop.test.ts
│   ├── llm/client.test.ts
│   ├── binance/orders.test.ts
│   ├── webhook/signal-buffer.test.ts
│   └── risk/manager.test.ts
├── logs/                     # Runtime logs (gitignored)
├── docs/
│   └── plans/
├── .env.example
├── package.json
└── tsconfig.json
```

## Data Flow (per cycle)

### 1. Fetch Market Data

For each pair (BTC, ETH, SOL):
- 1h + 4h OHLCV candles (last 20)
- Current funding rate
- Open interest
- Current open positions (if any)
- Account balance

### 2. Collect Signals

From SignalBuffer: any TradingView alerts received since last cycle.

### 3. LLM Decision

GPT 5.3 receives a structured prompt with all market data and returns:

```json
{
  "decisions": [
    {
      "pair": "BTCUSDT",
      "action": "LONG | SHORT | CLOSE | HOLD",
      "size_pct": 30,
      "leverage": 10,
      "stop_loss_pct": 2,
      "take_profit_pct": 4,
      "reasoning": "..."
    }
  ]
}
```

### 4. Risk Check

Hard limits enforced before execution:
- Max leverage: 10x
- Max position per pair: 33% of balance
- Max total exposure: 50% of balance
- Stop-loss: mandatory, max 3%
- Max loss per session: $5 (50% of deposit) → auto-shutdown

### 5. Execute

Place or close orders via Binance Futures API.

### 6. Log

All activity logged to JSONL files:
- `decisions.jsonl`: timestamp, input data summary, LLM response, execution result
- `trades.jsonl`: timestamp, pair, side, size, price, leverage, PnL
- `errors.jsonl`: API failures, LLM errors, order rejections

Console output with colored real-time stream.

## OpenAI OAuth

Authentication via openclaw approach:
- Reference: `https://github.com/openclaw/openclaw/blob/main/src/commands/openai-codex-oauth.ts`
- Uses `@mariozechner/pi-ai` library for OAuth PKCE flow
- Tokens stored locally and auto-refreshed
- Credentials: OAuth access_token + refresh_token

## TradingView Webhook

Express endpoint receives POST requests:

```
POST /webhook
Content-Type: application/json

{
  "signal": "BUY" | "SELL",
  "pair": "BTCUSDT",
  "indicator": "RSI",
  "value": 72,
  "timeframe": "1h"
}
```

Signals stored in a circular buffer (max 50 signals, TTL 30 min). LLM receives them as supplementary context.

## TDD Strategy

Tests written before implementation for each module:

1. **signal-buffer.test.ts** — add/get/clear signals, TTL expiration, buffer overflow
2. **risk/manager.test.ts** — limit validation, rejection of oversized positions, auto-shutdown trigger
3. **binance/orders.test.ts** — mock API, order formation, error handling
4. **llm/client.test.ts** — mock GPT, JSON response parsing, error recovery
5. **trading-loop.test.ts** — integration test of full cycle (all mocked)

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict mode)
- **Test framework**: Vitest
- **HTTP server**: Express
- **Binance**: `binance` npm package (or raw REST)
- **OpenAI**: OAuth via openclaw approach + direct API calls
- **Logging**: Custom JSONL logger + `chalk` for console colors

## Security

- API keys in `.env` (never committed)
- `.env.example` with placeholder values
- Binance API key with futures-only permissions (no withdrawals)
- Webhook endpoint with optional secret token validation
