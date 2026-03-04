# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # run bot (tsx, no compile step)
npm run test          # run all tests
npm run build         # compile TypeScript → dist/
npm run audit:bot     # live account snapshot (Binance + logs + news)
npm run soul:insight "text" # inject external insight into soul.md

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
2. Get portfolio state + compute real sessionPnl from Binance balance delta
3. Compute 1h and 4h technical indicators
4. Auto-exit stale positions (>8h <1% P&L) and max-hold (>24h)
5. Refresh news cache if stale + macro data (every 3h)
6. Call `LLMClient.analyze()` with enriched context (data narratives, session state, risk status)
7. For each decision: check churn cooldown → `RiskManager.validate(decision, portfolio, validationCtx)` → `OrderExecutor.execute()`
8. Log performance snapshot

**Config split** — two files, two purposes:
- `.env` — secrets only (API keys). Never read directly; always via `loadConfig()`. Never modify or log.
- `config.yaml` (planned, not yet implemented) — all trading parameters. Currently all params read from `process.env` with hardcoded defaults in `src/config.ts`.

**LLM flow** (`src/llm/`):
- `client.ts` — ChatGPT Codex API via SSE streaming; `call()` for analyst agent, `analyze()` for trading decisions. Smart JSON extraction with targeted regex + retry on parse failure. Parse errors logged to `logs/parse-errors.jsonl`.
- `oauth.ts` — OpenAI OAuth token refresh (default auth); fallback to `OPENAI_API_KEY` if set
- `prompts.ts` — `buildSystemPrompt()` with comprehensive strategy (multi-timeframe, confluence checklist, confidence guide, regime scaling). `buildEnrichedPrompt()` assembles all data + interpreted narratives (volume alerts, VWAP bias, Bollinger alerts, funding trends, trade performance/streaks, session P&L/risk status).

**Order execution** (`src/binance/orders.ts`):
- Every LONG/SHORT places 3 orders: MARKET (entry) → STOP_MARKET → TAKE_PROFIT_MARKET
- SL/TP use `closePosition: 'true'` (not `quantity + reduceOnly`) — this is required by Binance Futures API
- **SL failure = cancel trade**: if SL placement fails, entry position is immediately closed (no unprotected positions)
- TP failure is non-fatal (position still protected by SL)
- CLOSE uses MARKET reduceOnly with exact position size fetched from Binance

**Risk manager** (`src/risk/manager.ts`):
- Validates every LONG/SHORT before execution with `ValidationContext` (indicators4h, fearGreed)
- Checks: confidence (min 55), leverage, position size %, stop-loss presence/range, total margin exposure %
- Hard guardrails: 4h trend confirmation, F&G leverage cap, session loss scaling, duplicate position check
- Shutdown trigger: `sessionPnl <= -(maxLossPct% × balance)` or `-(maxLossUsd)` if pct=0
- HOLD, CLOSE, FETCH_NEWS bypass all checks

**News system** (`src/news/`):
- `cryptopanic.ts` — fetches headlines via Apify (requires `APIFY_API_TOKEN`)
- `news-analyst.ts` — separate LLM call (`llm.call()`) that classifies headlines into structured signals (importance 1–10, direction, catalyst, timeframe)
- `news-cache.ts` — file cache at `~/.indic-bot/news-cache.json`; `shouldRefresh(intervalHours)` uses `parseFloat` so fractional hours (e.g. 0.33) work
- `news-db.ts` — SQLite (`better-sqlite3`) persistent news store at `~/.indic-bot/news.db`; deduplicates by `(title, date)`, exposes `getRecent(hours)` returning rows with computed `age_hours` column
- LLM receives `NewsAnalysis` (structured signals), not raw headlines
- `fear-greed.ts` — fetches Fear & Greed index from alternative.me API

**Soul system** (`src/memory/`):
- `soul-keeper.ts` — manages `~/.indic-bot/soul.md` with section-level read/write
- `soul-review.ts` — LLM self-reflection agent, updates narrative sections every ~20 cycles
- `soul-stats.ts` — computes SoulStats (win rate, streaks, pair performance) from TradeRecord[]
- `scripts/soul-insight.ts` — CLI for injecting external insights (`npm run soul:insight "text"`)

**Persistent state** (all in `~/.indic-bot/`):
- `memory.json` — session notes + last 20 closed trades + `start_balance` + `last_order_result`, read at loop start each cycle
- `news-cache.json` — current news analysis
- `news-history.jsonl` — append-only history of every news fetch
- `soul.md` — persistent LLM identity document (auto-updated stats, rejections, exits + LLM-written narrative)

**Logs** (`logs/` directory, JSONL):
- `decisions.jsonl` — all LLM decisions + RISK_REJECTED entries
- `trades.jsonl` — executed LONG/SHORT/CLOSE
- `errors.jsonl` — order failures, loop errors
- `performance.jsonl` — balance + open positions per cycle; `cycleCount` resets to 0 on bot restart (used for session detection)
- `parse-errors.jsonl` — LLM response parse failures (for debugging)
- `tokens.jsonl` — LLM token usage per call

**TradingView webhook** (`src/webhook/`): Express server on `WEBHOOK_PORT` (default 3000); signals buffered in-memory and drained each cycle into LLM context.

## Infrastructure

**GCP VM (production)**: `34.179.171.213` — europe-west3-a (Frankfurt), e2-small, Debian 12
- SSH: `ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213`
- Bot runs via pm2, logs at `~/indic-bot/logs/pm2.log`
- This IP is whitelisted in Binance API key
- Session files: `~/.indic-bot/` (oauth-credentials.json, memory.json, news-cache.json)
- To deploy updates: `rsync -az -e "ssh -i ~/.ssh/google_compute_engine" --exclude node_modules --exclude .git /path/to/04_Indic/ mykolat@34.179.171.213:~/indic-bot/`

## Key Gotchas

- **TypeScript ESM** — all local imports require `.js` extension (e.g. `import ... from './config.js'`), even though files are `.ts`. This is required by `"module": "NodeNext"`.
- **`sessionPnl`** — now computed from real Binance balance delta (`currentBalance - startBalance`). `start_balance` persisted in `memory.json`.
- **Churn cooldown** — stored in `TradingLoop.lastClosedAt` (in-memory Map). Resets on bot restart.
- **Testnet URL** — `demo-fapi.binance.com` (not `testnet.binancefuture.com`). Set via `BINANCE_TESTNET=true` in `.env`.
- **`scripts/audit.ts`** uses `loadConfig()` and connects to live Binance — runs correctly against live account.

**Fetch timeouts** (`src/utils/fetch-timeout.ts`): AbortController-based timeouts for all external API calls (15s Apify, 10s CoinGecko, 5s Fear&Greed).

## Planned (not yet implemented)

- `config.yaml` migration — trading params from `process.env` defaults → `config.yaml` (AI-writable). See `docs/plans/2026-03-04-audit-plan.md`.
- `npm run audit:debug` — JSON mode for AI-driven self-healing audit. See `docs/plans/2026-03-04-audit-design.md`.
- **Soul system** (`src/memory/soul-keeper.ts`, `soul-review.ts`, `soul-stats.ts`) — persistent `~/.indic-bot/soul.md` injected into every LLM prompt; LLM self-reflection every ~20 cycles via `SoulReviewAgent`; `npm run soul:insight "text"` for external insight injection. See `docs/plans/2026-03-04-soul-md-plan.md`.
- **max-info-fetch** (branch `feat/max-info-fetch`) — 15m candles, funding rate history (8 periods), long/short ratio, order book imbalance, OI delta tracking, system prompt update from testnet → live mode. See `docs/plans/2026-03-04-max-info-fetch.md`.
