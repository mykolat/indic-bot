# Observability DB — Supabase PostgreSQL Migration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fragmented JSONL/JSON/SQLite logging with a unified Supabase PostgreSQL database that enables full trade lifecycle traceability: prompt → decision → execution → P&L.

**Architecture:** Bot writes directly to PG via `pg` npm connection pool. Supabase provides REST API + dashboard for web UI. JSONL files kept as backup during migration. 19 tables with `cycle_id` as the spine linking everything.

**Tech Stack:** Supabase PostgreSQL, `pg` npm package, pgvector extension for embeddings

**Supabase:** `https://kyuyqfbjeopyysxeltxl.supabase.co`

---

## Context

Бот генерує ~7 JSONL файлів + 3 JSON stores + 1 SQLite, але дані фрагментовані і не зв'язані. Неможливо відповісти "чому бот закрив BNB о 15:33" без ручного cross-reference. LLM промпти і відповіді втрачаються після циклу. Зовнішній аудит підтвердив: без повної телеметрії неможливо дебажити чи покращувати систему.

## Database Schema (19 tables)

### Core Trading
```sql
-- 1. Bot sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_balance NUMERIC NOT NULL,
  config JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- 2. Trading loop cycles (replaces performance.jsonl)
CREATE TABLE cycles (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  cycle_number INT NOT NULL,
  balance NUMERIC NOT NULL,
  session_pnl NUMERIC,
  open_positions JSONB,
  volume_ratio NUMERIC,
  confluence_score INT,
  confluence_factors TEXT[],
  regime TEXT,
  regime_confidence NUMERIC,
  fear_greed_value INT,
  layer INT,
  filter_warning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Every LLM call (replaces tokens.jsonl + adds prompts/responses)
CREATE TABLE llm_conversations (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT REFERENCES cycles(id),
  session_id UUID REFERENCES sessions(id),
  layer INT NOT NULL,
  model TEXT NOT NULL,
  method TEXT NOT NULL,
  label TEXT,
  system_prompt TEXT,
  user_prompt TEXT,
  raw_response TEXT,
  reasoning_chain TEXT,
  tokens_in INT,
  tokens_out INT,
  estimated BOOLEAN DEFAULT FALSE,
  latency_ms INT,
  parsed_ok BOOLEAN,
  parse_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Each decision from LLM (replaces decisions.jsonl)
CREATE TABLE trade_decisions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES llm_conversations(id),
  cycle_id BIGINT REFERENCES cycles(id),
  pair TEXT NOT NULL,
  action TEXT NOT NULL,
  size_pct NUMERIC,
  leverage INT,
  stop_loss_pct NUMERIC,
  take_profit_pct NUMERIC,
  confidence INT,
  reasoning TEXT,
  regime TEXT,
  regime_confidence NUMERIC,
  regime_override TEXT,
  volume_ratio NUMERIC,
  confluence_score INT,
  confluence_factors TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Trade entry (replaces trades.jsonl for LONG/SHORT)
CREATE TABLE trade_executions (
  id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT REFERENCES trade_decisions(id),
  pair TEXT NOT NULL,
  side TEXT NOT NULL,
  action TEXT NOT NULL,
  entry_price NUMERIC,
  fill_price NUMERIC,
  quantity NUMERIC,
  leverage INT,
  sl_price NUMERIC,
  tp_price NUMERIC,
  order_id BIGINT,
  algo_sl_id TEXT,
  algo_tp_id TEXT,
  size_usd NUMERIC,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Trade close
CREATE TABLE trade_closes (
  id BIGSERIAL PRIMARY KEY,
  execution_id BIGINT REFERENCES trade_executions(id),
  close_decision_id BIGINT REFERENCES trade_decisions(id),
  pair TEXT NOT NULL,
  exit_price NUMERIC,
  exit_reason TEXT NOT NULL,
  pnl_usd NUMERIC,
  pnl_pct NUMERIC,
  held_hours NUMERIC,
  order_id BIGINT,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Risk validation per decision
CREATE TABLE risk_validations (
  id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT REFERENCES trade_decisions(id),
  passed BOOLEAN NOT NULL,
  rejection_reason TEXT,
  checks JSONB,
  shutdown_triggered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Intelligence
```sql
-- 8. All news articles (replaces news.db)
CREATE TABLE news_articles (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  coins TEXT[],
  sentiment NUMERIC,
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(title, published_at)
);

-- 9. News analysis (LLM output per batch)
CREATE TABLE news_analyses (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT REFERENCES cycles(id),
  overall_sentiment TEXT,
  fed_stance TEXT,
  risk_appetite TEXT,
  dominance_trend TEXT,
  signals JSONB,
  risk_events TEXT[],
  article_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Macro data snapshots
CREATE TABLE macro_snapshots (
  id BIGSERIAL PRIMARY KEY,
  wti NUMERIC, dxy NUMERIC, sp500 NUMERIC, vix NUMERIC,
  eurusd NUMERIC, gold NUMERIC, btc_dominance NUMERIC,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. LLM macro analysis
CREATE TABLE macro_analyses (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT REFERENCES macro_snapshots(id),
  cycle_id BIGINT REFERENCES cycles(id),
  summary TEXT,
  risk_level TEXT,
  key_factors JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Swarm persona responses
CREATE TABLE swarm_personas (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES llm_conversations(id),
  persona TEXT NOT NULL,
  model TEXT,
  raw_response TEXT,
  vote TEXT,
  confidence INT,
  reasoning TEXT,
  tokens_in INT,
  tokens_out INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Memory & Learning
```sql
-- 13. Episodic memories (replaces memory-graph.json)
CREATE TABLE episodic_memories (
  id BIGSERIAL PRIMARY KEY,
  episode_key TEXT UNIQUE,
  state_description TEXT,
  outcome TEXT,
  embedding VECTOR(1536),
  similarity_score NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Trade stories (replaces trade-stories.jsonl)
CREATE TABLE trade_stories (
  id BIGSERIAL PRIMARY KEY,
  execution_id BIGINT REFERENCES trade_executions(id),
  close_id BIGINT REFERENCES trade_closes(id),
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price NUMERIC, exit_price NUMERIC,
  pnl_pct NUMERIC,
  regime_at_entry TEXT,
  regime_at_exit TEXT,
  story TEXT,
  lesson TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15. Memory review agent results
CREATE TABLE memory_reviews (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  cycle_number INT,
  trigger_reason TEXT,
  review_text TEXT,
  actions_taken JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Observability
```sql
-- 16. Errors (replaces errors.jsonl)
CREATE TABLE errors (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT REFERENCES cycles(id),
  code TEXT,
  message TEXT NOT NULL,
  details JSONB,
  stack TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 17. Token usage (replaces tokens.jsonl)
CREATE TABLE token_usage (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES llm_conversations(id),
  model TEXT NOT NULL,
  method TEXT NOT NULL,
  label TEXT,
  tokens_in INT,
  tokens_out INT,
  estimated BOOLEAN DEFAULT FALSE,
  cost_usd NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 18. TradingView webhook signals
CREATE TABLE webhook_signals (
  id BIGSERIAL PRIMARY KEY,
  pair TEXT NOT NULL,
  action TEXT,
  source TEXT DEFAULT 'tradingview',
  payload JSONB,
  consumed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 19. Technical indicators per pair per cycle
CREATE TABLE indicator_snapshots (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT REFERENCES cycles(id),
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  rsi NUMERIC, ema_short NUMERIC, ema_long NUMERIC,
  macd NUMERIC, macd_signal NUMERIC, macd_histogram NUMERIC,
  adx NUMERIC, atr NUMERIC, atr_pct NUMERIC,
  vwap NUMERIC, vwap_diff_pct NUMERIC,
  bb_upper NUMERIC, bb_lower NUMERIC, bb_width NUMERIC,
  volume_ratio NUMERIC,
  trend TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_cycles_session ON cycles(session_id, created_at);
CREATE INDEX idx_llm_conv_cycle ON llm_conversations(cycle_id);
CREATE INDEX idx_decisions_pair_action ON trade_decisions(pair, action, created_at);
CREATE INDEX idx_executions_pair ON trade_executions(pair, opened_at);
CREATE INDEX idx_closes_pair ON trade_closes(pair, closed_at);
CREATE INDEX idx_errors_created ON errors(created_at);
CREATE INDEX idx_news_fetched ON news_articles(fetched_at);
CREATE INDEX idx_indicators_cycle_pair ON indicator_snapshots(cycle_id, pair);
```

## Integration Points (exact line refs)

| Hook | File | Line | What to write |
|------|------|------|---------------|
| Component init | `src/index.ts` | 161–201 | Init DB pool, pass to TradingLoop deps |
| Cycle end | `src/trading-loop.ts` | 773 | Insert `cycles` row after `logPerformance()` |
| LLM analyze | `src/llm/client.ts` | 73–74 | Save prompt+response+tokens to `llm_conversations` |
| LLM call | `src/llm/client.ts` | 374 | Save to `llm_conversations` (label='call') |
| LLM retry | `src/llm/client.ts` | 111 | Save retry attempt to `llm_conversations` |
| Swarm personas | `src/llm/swarm-agent.ts` | 27 | Save each persona response to `swarm_personas` |
| Each decision | `src/trading-loop.ts` | 577 | Insert `trade_decisions` after `logDecision()` |
| Risk validation | `src/trading-loop.ts` | 689 | Insert `risk_validations` |
| LONG/SHORT entry | `src/trading-loop.ts` | 754 | Insert `trade_executions` |
| LLM CLOSE | `src/trading-loop.ts` | 710 | Insert `trade_closes` with exit_reason='LLM_CLOSE' |
| Auto-exit | `src/trading-loop.ts` | 212 | Insert `trade_closes` with exit_reason='AUTO_STALE/MAX_HOLD' |
| Flash crash | `src/trading-loop.ts` | 139 | Insert `trade_closes` with exit_reason='FLASH_CRASH' |
| Layer 3 close | `src/trading-loop.ts` | 545 | Insert `trade_closes` with exit_reason='EMERGENCY' |
| Indicators | `src/trading-loop.ts` | 253–274 | Insert `indicator_snapshots` per pair |
| News fetch | `src/news/cryptopanic.ts` + `rss-fetcher.ts` | various | Insert `news_articles` |
| News analysis | `src/news/news-analyst.ts` | various | Insert `news_analyses` |
| Macro fetch | `src/news/macro-fetcher.ts` | various | Insert `macro_snapshots` |
| Macro analysis | `src/news/macro-analyst.ts` | various | Insert `macro_analyses` |
| Token log | `src/llm/token-logger.ts` | various | Insert `token_usage` |
| Error log | `src/logger/index.ts` | 24–27 | Insert `errors` |
| Webhook | `src/webhook/handler.ts` | various | Insert `webhook_signals` |
| Trade story | `src/logging/trade-story.ts` | various | Insert `trade_stories` |
| Memory review | `src/memory/memory-review.ts` | various | Insert `memory_reviews` |
| Episodic RAG | `src/memory/episodic-store.ts` | various | Migrate to PG + pgvector |

## Implementation Tasks

### Task 1: Setup — DB module + connection pool
**Files:** Create `src/db/connection.ts`, `src/db/types.ts`, `src/db/repository.ts`
- Install `pg` + `@types/pg`
- Add `DATABASE_URL` to `src/config.ts` (`loadConfig()` line 60)
- Connection pool with error handling and reconnection
- Run schema migration (CREATE TABLE IF NOT EXISTS)

### Task 2: Core cycle tracking
**Files:** Modify `src/index.ts` (line 161), `src/trading-loop.ts` (line 773)
- Insert `sessions` row at startup
- Insert `cycles` row at each cycle end
- Thread `cycleId` through the loop

### Task 3: LLM conversation capture
**Files:** Modify `src/llm/client.ts` (lines 73, 111, 374), `src/llm/fallback-client.ts`
- Save system_prompt + user_prompt + raw_response to `llm_conversations`
- Return `conversationId` for linking to decisions

### Task 4: Trade decisions + risk validations
**Files:** Modify `src/trading-loop.ts` (lines 577, 689)
- Insert `trade_decisions` linked to `conversationId`
- Insert `risk_validations` linked to `decisionId`

### Task 5: Trade executions + closes
**Files:** Modify `src/trading-loop.ts` (lines 754, 710, 212, 139, 545)
- Insert `trade_executions` with fill_price, SL/TP prices
- Insert `trade_closes` for every exit path with `exit_reason`

### Task 6: Intelligence tables
**Files:** Modify `src/news/cryptopanic.ts`, `rss-fetcher.ts`, `news-analyst.ts`, `macro-fetcher.ts`, `macro-analyst.ts`
- Migrate news from SQLite to PG (`news_articles`, `news_analyses`)
- Add `macro_snapshots` + `macro_analyses`

### Task 7: Swarm + indicators + observability
**Files:** Modify `src/llm/swarm-agent.ts` (line 27), `src/trading-loop.ts` (lines 253–274), `src/logger/index.ts`
- Save swarm persona responses
- Save indicator snapshots per pair per cycle
- Dual-write errors: JSONL + DB

### Task 8: Memory + episodic migration
**Files:** Modify `src/memory/episodic-store.ts`, `memory-review.ts`, `src/logging/trade-story.ts`
- Enable pgvector in Supabase
- Migrate episodic store from JSON to PG
- Save trade stories and memory reviews to DB

### Task 9: Audit script migration
**Files:** Modify `scripts/audit.ts`
- Read from DB instead of JSONL where available
- Add new queries: "last 5 trade close reasons", "LLM response for trade X"

## Key Design Decisions

1. **Direct PG via `pg` npm** — bot writes via connection pool; dashboard reads via Supabase REST
2. **`cycle_id` is the spine** — every table links to a cycle
3. **conversation → decision → execution → close** — full trade lifecycle
4. **pgvector for embeddings** — replaces JSON cosine similarity
5. **JSONB for flexible fields** — config, indicators, signals
6. **Dual-write during migration** — JSONL backup continues, gradually deprecated
7. **DB writes are fire-and-forget** — DB failure must not crash trading loop

## Verification

1. `npm run build` — TypeScript compiles
2. `npx vitest run` — all tests pass
3. Supabase dashboard: all 19 tables visible
4. Run bot 3 cycles, verify query:
   ```sql
   SELECT d.pair, d.action, d.reasoning, d.confidence, c.raw_response
   FROM trade_decisions d
   JOIN llm_conversations c ON d.conversation_id = c.id
   ORDER BY d.created_at DESC LIMIT 5
   ```
5. Audit script queries DB successfully
