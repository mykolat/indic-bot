# Indic — AI-Native Crypto Futures Trading Bot

> 5 AI agents debate every trade. Real money. Real results.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)
![Tests](https://img.shields.io/badge/tests-324%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-LIVE-red)
![Exchange](https://img.shields.io/badge/exchange-Binance%20Futures-yellow?logo=binance)

Indic is an open-source autonomous trading system for Binance USDS-M Futures.
Before every trade, a **multi-agent AI debate** runs: 5 specialist personas argue for and against the position, a judge aggregates by conviction — then and only then an order is placed.

No manual decisions. No black box. Every trade is fully traceable.

---

## Live Results

> Running on real capital since March 2026.

| Metric | Value |
|--------|-------|
| Win rate | **100%** |
| Best single trade | **+20%** |
| Avg return per trade | **+10.3%** |
| Avg hold time | ~3 hours |
| Executions | Binance USDS-M Futures, live |

---

## Why Indic?

Markets move faster than any human can react. Simple algo bots follow fixed rules that break in volatile regimes. LLM wrappers call one model and hope for the best.

Indic does something different:

- **Dual-loop architecture** — a lightweight Watchdog scans every 60s for anomalies; the Brain runs a full AI cycle every 10 minutes
- **Multi-agent debate** — 5 AI personas with opposing mandates argue before consensus is reached
- **Market regime awareness** — the system classifies the current regime and adjusts leverage, filters, and position sizing dynamically
- **3-layer resilience** — if the primary LLM fails, a fallback chain ensures the bot never goes dark
- **Full observability** — every prompt, decision, execution, and P&L row is stored in Postgres with pgvector

---

## How It Works

```
Watchdog (every 60s)          Algorithmic — no LLM
  Price spike detection        OI anomalies
  Order book imbalance         Funding rate shifts
         |
         v
Brain (every 10 min)          AI-powered full cycle
  Flash crash guard (Grok)    Market panic scan — abort if PANIC
  Market snapshots             Candles + OI + funding + order book
  Technical indicators         RSI, EMA, ATR, volumeRatio
  News + macro                 CryptoPanic + RSS + Yahoo Finance + Fear&Greed
  Episodic memory              Graph RAG: similar past situations retrieved
  Watchdog summary             Aggregated anomalies since last cycle
         |
         v
  Swarm Debate (5 AI agents)
  risk_manager   |  bull_thesis  |  bear_thesis
  market_structure  |  devils_advocate  [+ Grok narrative_expert]
  Judge aggregates by probability × confidence — up to 5 debate rounds
         |
         v
  RiskManager.validate()       Hard guardrails before any order
         |
         v
  OrderExecutor                MARKET + STOP_MARKET + TAKE_PROFIT_MARKET
         |
         v
  Supabase (20 tables)         Full traceability: prompt → decision → execution → P&L
```

---

## Algorithms

### Technical Signals
- **RSI(14)** — momentum filter; entry only in healthy range
- **EMA(20/50)** — trend direction confirmation
- **ATR(14)** — volatility-based SL/TP sizing
- **Volume ratio** — triggers Swarm Debate when BTC volumeRatio > 1.5x
- **Funding rate** — extreme negative funding leans LONG
- **Open interest** — OI spikes feed into anomaly detection

### Market Regime Classifier
5 regimes with confidence scoring: `BullTrend`, `BearTrend`, `Range`, `Breakout`, `Capitulation`.
Each regime has a dedicated filter profile: RSI range, min volume, confluence threshold, leverage multiplier, SL style.

### Swarm Multi-Agent Debate
```
risk_manager      — argues reasons NOT to trade; catastrophic loss focus
bull_thesis       — finds reasons to go long; momentum, breakouts
bear_thesis       — finds reasons to go short; distribution, weakness
market_structure  — reads funding, OI, order book, microstructure
devils_advocate   — must argue OPPOSITE of consensus; forced contrarian
narrative_expert  — Grok reads X/Twitter for market narrative (optional)
```
Each expert outputs structured JSON: `thesis`, `arguments`, `probability_of_success`, `key_risks`, `confidence`.

A **multi-level judge** (up to 5 rounds) weighs outputs by `probability × confidence`. If experts disagree, the judge requests a second round with specific speakers. Devil's Advocate risks always get extra weight. Final decision is a weighted consensus.

**Fingerprint dedup**: if market state is unchanged (regime, positions, volume bucket, Fear&Greed bucket), the prior consensus is reused — no redundant LLM calls.

### Episodic Graph RAG
Every market state is embedded via `text-embedding-3-small`. Before the swarm runs, the system retrieves the 3 most similar past episodes (cosine > 0.7) and injects them into the prompt — the bot learns from its own history.

### 3-Layer LLM Resilience
```
Layer 1  ChatGPT Codex (OAuth)    Full prompt, Swarm if needed
Layer 2  GPT-4o-mini (API key)    Minimal prompt, HOLD/CLOSE only
Layer 3  Rule-based               No LLM; SL/TP on Binance; close all if session PnL < -5%
```
Circuit breaker: 3 consecutive all-fail Binance cycles → skip cycle.

### Risk Manager
Hard guardrails enforced before every order:
- Session P&L ≤ `-maxLossPct%` → **shutdown**
- Leverage > `maxLeverage` → reject
- Position size > `maxPositionPct` → reject
- SL missing or wider than `maxStopLossPct` → reject
- Total margin > `maxExposurePct` → reject
- 4h trend confirmation required for LONG/SHORT
- Fear & Greed leverage cap

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Secrets
cp .env.example .env
# Fill in: BINANCE_API_KEY, BINANCE_API_SECRET, OPENAI_MODEL

# 3. Trading parameters
cp config.example.yaml config.yaml
# Edit: pairs, leverage, risk limits, cooldowns

# 4. Run (dev)
npm run dev

# 5. Run autonomous
pm2 start "npm run dev" --name indic-bot
```

Requires Node.js 20+. Works on testnet (`BINANCE_TESTNET=true`) before going live.

---

## Configuration

Two files, two purposes:

**`.env`** — secrets only (never committed, never read by AI):
```env
BINANCE_API_KEY=
BINANCE_API_SECRET=
OPENAI_MODEL=gpt-5.4
XAI_API_KEY=          # optional: Grok narrative_expert + flash crash guard
APIFY_API_TOKEN=      # optional: CryptoPanic news
SUPABASE_PASS=        # optional: Postgres observability
```

**`config.yaml`** — all trading parameters (git-versioned, AI-writable during audits):
```yaml
trading:
  pairs: [BTCUSDT, ETHUSDT, SOLUSDT]
  maxLeverage: 20
  maxPositionPct: 50
  maxLossPct: 10
  churnCooldownMs: 900000   # 15min re-entry block after close
  loopIntervalMs: 60000
```

---

## Observability

Every cycle is fully traceable through 20 Supabase tables:

```
sessions → cycles → trade_decisions → trade_executions → trade_closes
                 → llm_conversations → swarm_personas → token_usage
                 → market_snapshots → news_articles → macro_snapshots
                 → episodic_memories (pgvector) → trade_stories
                 → risk_validations → errors → indicator_snapshots
```

`cycle_id` is the spine. `conversation → decision → execution → P&L close` is fully linked.
Runs fine without Supabase (graceful fallback to JSONL logs).

```bash
npm run audit       # human-readable snapshot: balance, positions, issues
npm run audit:db    # full DB audit: conversations, personas, token usage
```

---

## Infrastructure

- **Runtime**: Node.js + tsx (no compile step in dev), pm2 in production
- **Exchange**: Binance USDS-M Futures (live + testnet)
- **LLM**: ChatGPT Codex (primary), GPT-4o-mini (fallback), Grok/xAI (sentinel + debate)
- **DB**: Supabase PostgreSQL + pgvector
- **Infra**: GCP e2-small (Frankfurt), €5/month
- **Deploy**: `npm run deploy` — rsync + pm2 restart

---

## Tests

```bash
npm test                            # 324 tests
npx vitest run tests/risk/          # risk manager
npx vitest run tests/llm/           # swarm, prompts, fingerprint, client
npx vitest run tests/binance/       # order executor, market data
npx vitest run tests/memory/        # episodic store
```

---

## Project Structure

```
src/
├── index.ts              Entry point
├── trading-loop.ts       Main cycle: fetch → debate → validate → execute
├── watchdog.ts           1-min algorithmic monitor
├── binance/              Market data, order execution
├── llm/
│   ├── swarm-agent.ts    Multi-agent debate (5 personas + judge)
│   ├── client.ts         ChatGPT Codex SSE client
│   ├── prompts.ts        All system + expert prompts
│   ├── agents.ts         Layer 1 parallel experts (news, macro, memory)
│   └── episodic-agent.ts Graph RAG retrieval
├── risk/
│   └── manager.ts        Hard guardrails before every order
├── market/
│   ├── regime-classifier.ts  5-regime market classifier
│   └── filter-profiles.ts    Per-regime trading parameters
├── news/                 CryptoPanic, RSS, macro, flash crash, Grok grounder
├── memory/               Episodic store, memory review, session state
├── db/                   Supabase connection, types, repository
└── webhook/              TradingView signal ingestion
```

---

## Contributing

Built by a solo trader. Early stage, actively developed.

PRs welcome. Open issues for bugs, ideas, integrations.

If you run it — share results. Good or bad.

---

## License

MIT
