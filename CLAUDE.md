# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # run bot (tsx, no compile step)
npm run test          # run all tests
npm run build         # compile TypeScript → dist/
npm run audit:bot     # live account snapshot (Binance + logs + news)

# Run a single test file:
npx vitest run tests/risk/manager.test.ts

# Run tests for a directory:
npx vitest run tests/binance/

# Bot process management:
pm2 start "npm run dev" --name indic-bot
pm2 restart indic-bot   # picks up config changes (use --update-env for .env changes)
pm2 logs indic-bot
pm2 flush indic-bot
```

## Architecture

**Entry point**: `src/index.ts` wires all components and starts the trading loop + Express webhook server.

**Main loop** (`src/trading-loop.ts` → `TradingLoop.runOnce()`):
1. Fetch market snapshots for all pairs in parallel
2. Compute technical indicators from 1h candles
3. Refresh news cache if stale (every `newsRefreshIntervalH` hours, currently 0.33 = 20min)
4. Call `LLMClient.analyze()` with full enriched context
5. For each decision: check churn cooldown → `RiskManager.validate()` → `OrderExecutor.execute()`
6. Log performance snapshot

**Config split** — two files, two purposes:
- `.env` — secrets only (API keys). Never read directly; always via `loadConfig()`. Never modify or log.
- `config.yaml` (planned, not yet implemented) — all trading parameters. Currently all params read from `process.env` with hardcoded defaults in `src/config.ts`.

**LLM flow** (`src/llm/`):
- `client.ts` — ChatGPT Codex API via SSE streaming; `call()` for analyst agent, `analyze()` for trading decisions
- `oauth.ts` — OpenAI OAuth token refresh (default auth); fallback to `OPENAI_API_KEY` if set
- `prompts.ts` — `buildSystemPrompt()` + `buildUserPrompt()` / `buildEnrichedPrompt()`. The enriched prompt assembles all market data, indicators, news analysis, portfolio, and session memory into a single string.

**Order execution** (`src/binance/orders.ts`):
- Every LONG/SHORT places 3 orders: MARKET (entry) → STOP_MARKET → TAKE_PROFIT_MARKET
- SL/TP use `closePosition: 'true'` (not `quantity + reduceOnly`) — this is required by Binance Futures API
- SL/TP failures are caught separately and logged but do NOT fail the trade — the MARKET order success is authoritative
- CLOSE uses MARKET reduceOnly with exact position size fetched from Binance

**Risk manager** (`src/risk/manager.ts`):
- Validates every LONG/SHORT before execution
- Shutdown trigger: `sessionPnl <= -(maxLossPct% × balance)` or `-(maxLossUsd)` if pct=0
- Checks: leverage, position size %, stop-loss presence/range, total margin exposure %
- HOLD, CLOSE, FETCH_NEWS bypass all checks

**News system** (`src/news/`):
- `cryptopanic.ts` — fetches headlines via Apify (requires `APIFY_API_TOKEN`)
- `news-analyst.ts` — separate LLM call (`llm.call()`) that classifies headlines into structured signals (importance 1–10, direction, catalyst, timeframe)
- `news-cache.ts` — file cache at `~/.indic-bot/news-cache.json`; `shouldRefresh(intervalHours)` uses `parseFloat` so fractional hours (e.g. 0.33) work
- LLM receives `NewsAnalysis` (structured signals), not raw headlines
- `fear-greed.ts` — fetches Fear & Greed index from alternative.me API

**Persistent state** (all in `~/.indic-bot/`):
- `memory.json` — session notes + last 20 closed trades, read at loop start each cycle
- `news-cache.json` — current news analysis
- `news-history.jsonl` — append-only history of every news fetch

**Logs** (`logs/` directory, JSONL):
- `decisions.jsonl` — all LLM decisions + RISK_REJECTED entries
- `trades.jsonl` — executed LONG/SHORT/CLOSE
- `errors.jsonl` — order failures, loop errors
- `performance.jsonl` — balance + open positions per cycle; `cycleCount` resets to 0 on bot restart (used for session detection)

**TradingView webhook** (`src/webhook/`): Express server on `WEBHOOK_PORT` (default 3000); signals buffered in-memory and drained each cycle into LLM context.

## Key Gotchas

- **TypeScript ESM** — all local imports require `.js` extension (e.g. `import ... from './config.js'`), even though files are `.ts`. This is required by `"module": "NodeNext"`.
- **`sessionPnl` is always 0** — tracked in `TradingLoop` but never updated after CLOSE trades. Known bug.
- **Churn cooldown** — stored in `TradingLoop.lastClosedAt` (in-memory Map). Resets on bot restart.
- **Testnet URL** — `demo-fapi.binance.com` (not `testnet.binancefuture.com`). Set via `BINANCE_TESTNET=true` in `.env`.
- **`scripts/audit.ts`** uses `loadConfig()` and connects to live Binance — runs correctly against live account.

## Planned (not yet implemented)

- `config.yaml` migration — trading params from `process.env` defaults → `config.yaml` (AI-writable). See `docs/plans/2026-03-04-audit-plan.md`.
- Enhanced indicators — MACD, Bollinger Bands, volume ratio, VWAP, 15m candles, L/S ratio, OI delta. See `docs/plans/2026-03-04-max-info-fetch.md`.
- `npm run audit:debug` — JSON mode for AI-driven self-healing audit. See `docs/plans/2026-03-04-audit-design.md`.
