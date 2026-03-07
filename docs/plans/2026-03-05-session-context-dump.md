# Session Context Dump — 2026-03-05

> Цей файл зберігає весь контекст сесії: знайдені проблеми, діагностику live-трейдів, архітектурні рішення для dual-loop. Рішення ще НЕ імплементовані — тільки проблеми та дизайн.

---

## 1. Audit Bugfix Status

Повний план: `docs/plans/CRIT-2026-03-05-audit-bugfix-plan.md`

### Виконано (3 HIGH)

| # | Fix | Файл |
|---|-----|------|
| 1 | FlashCrash PANIC -> close all positions | `trading-loop.ts:128-146` |
| 2 | cosineSimilarity NaN guard + embedding null-check + episodic store validation | `embedding-client.ts`, `episodic-store.ts` |
| 3 | computeVolumeRatio openTimes/volumes length guard | `technical.ts:132` |

### НЕ виконано (5 MEDIUM)

| # | Bug | Файл:рядок | Вплив |
|---|-----|-----------|-------|
| 4 | Swarm `lastNextCheckMinutes` overwrite to 5 | `trading-loop.ts:506` | Dynamic intervals не працюють в swarm mode |
| 5 | `Array.isArray(newsAnalysis)` на об'єкт NewsAnalysis | `trading-loop.ts:438` | `hasNewsCatalyst` завжди false, confluence занижений на 1 |
| 6 | Fallback MemoryKeeper path `./tmp` | `trading-loop.ts:401` | Layer1 experts читають порожню memory |
| 7 | Swarm JSON brace-matcher ігнорує `{}` в strings | `swarm-agent.ts:75-88` | Може обрізати валідний consensus JSON |
| 8 | `next_check_minutes` без range validation | `swarm-agent.ts:97` | 0/negative/NaN ламає interval |
| 9 | SwarmAgent створюється безумовно | `index.ts:142` | Немає opt-out, зайві API credits |
| 10 | MACD O(n^2) + EMA seed closes[0] замість SMA | `technical.ts:62-105` | Неточні індикатори |
| 11 | Test: vi.spyOn на imported module + brittle call count | `trading-loop.test.ts:577,130` | Fragile tests |

---

## 2. Live Trading Діагностика (2026-03-05)

### Що сталось

3 позиції закриті ботом ДО SL/TP:

| # | Pair | Entry | Close | Duration | PnL margin | SL price | SL hit? |
|---|------|-------|-------|----------|------------|----------|---------|
| 1 | BNB | 656.10 | 654.24 | 1h 4m | -2.4% | ~641 | Ні |
| 2 | BTC | 72,580 | 72,028 | 54m | -4.5% | ~71,274 | Ні |
| 3 | BTC | 72,491 | 71,820 | 8m | -5.9% | ~71,188 | Ні |

Session PnL: ~-$6 (start $186 -> end ~$180)

### Кореневі причини

#### Причина 1: LLM не знає про SL/TP ордера на біржі

SL/TP **були коректно виставлені** (підтверджено скріншотами). Код `orders.ts:47-53` рахує SL від fill price — правильно.

Але LLM **не отримує інформацію** про SL/TP ордера в промпті. Він бачить тільки:
- `unrealizedPnlPct` (поточний збиток)
- `sessionPnl` (загальний drawdown)
- Loss streak count

Без знання що SL стоїть далеко, LLM паніканує і закриває рано.

**Доказ з логів:**
```
BNB CLOSE reasoning: "Open long is at -2.4% after 1.1h... In a critical drawdown state,
reducing risk and flattening prevents breach of the -2.5% time-based fail condition"

BTC #1 CLOSE reasoning: "position already -4.5%... Session drawdown critical (-20.79%)
with 3-loss streak... capital preservation and de-risking take priority"

BTC #2 CLOSE reasoning: "already -5.9% with session drawdown -22% and 4-loss streak...
capital preservation dominates"
```

LLM жодного разу не згадує SL — він не знає що захист є.

#### Причина 2: Немає position lock / entry thesis persistence

Кожен цикл (1-2 хв) LLM отримує повний snapshot і вирішує заново. Він не пам'ятає:
- Чому зайшов (entry thesis)
- Який план (SL/TP рівні)
- Скільки готовий чекати

Паттерн: `signal -> open -> recalc -> close` замість `signal -> open -> manage`

#### Причина 3: Cascading failure через session drawdown

**Примітка:** суми sessionPnl нижче — з внутрішніх логів бота, можуть не збігатись з реальним балансом (~$186→~$180).
```
11:10  SL API errors (5x) для ранніх ордерів
       -> session PnL починає падати
12:29  BNB LONG (session PnL вже -$0.15)
13:33  BNB CLOSE при -2.4% (session PnL = -$33.6)
       <- cascading: попередні збитки роблять LLM панічним
13:49  BTC LONG (session PnL = -$38.7, "drawdown critical але BTC мій найкращий")
14:43  BTC CLOSE при -4.5% (LLM + Swarm 2/3 experts = CLOSE)
15:02  BTC LONG знову ("reduced size due to loss streak")
15:10  BTC CLOSE через 8 хв (confidence 95 на CLOSE — максимум за день)
```

#### Причина 4: Bug #5 з аудиту — hasNewsCatalyst завжди false

`trading-loop.ts:438` — `Array.isArray(newsAnalysis)` на об'єкт `NewsAnalysis` -> confluence score занижений на 1 пункт. Бот заходить з confluence 2/5 замість 3/5.

#### Додатково: Помилки на біржі

```
11:10  "SL failed: Order type not supported" (5x) — для РАННІХ ордерів (не BNB/BTC)
16:38  "Quantity less than or equal to zero" — BTC LONG fail
19:19  "Precision is over the maximum defined" — XRP LONG fail
```

SL error о 11:10 — це для 5 паралельних ордерів які fail'нули і одразу закрились (SL fail = cancel trade logic працює). Це НЕ впливає на BNB/BTC трейди о 12:29+.

---

## 3. DB Observability — Прогалини

19 таблиць спроектовано, але інтеграція ~40%.

### Що пишеться в DB
- sessions, cycles, trade_decisions, trade_executions (частково), trade_closes (тільки LLM_CLOSE), risk_validations, indicator_snapshots, swarm_personas, llm_conversations (тільки swarm), episodic_memories

### Що НЕ пишеться
- `llm_conversations` — main analyze(), Layer1 experts, fallback LLM
- `news_articles`, `news_analyses` — не інтегровано
- `macro_snapshots`, `macro_analyses` — не інтегровано
- `token_usage` — не інтегровано
- `errors` — не інтегровано
- `webhook_signals` — не інтегровано
- `trade_stories`, `memory_reviews` — не інтегровано
- `trade_closes` — auto-exit, flash crash, Layer 3 emergency не пишуться

### Критично: trade_executions не зберігає SL/TP

```typescript
// Зараз:
insertTradeExecution({
  decision_id, pair, side, action, leverage, order_id, size_usd
});

// Відсутнє:
fill_price, sl_price, tp_price, quantity, algo_sl_id, algo_tp_id
```

Це саме ті поля які потрібні для дебагу "чому бот закрив до SL".

---

## 4. Dual-Loop Architecture — Дизайн (НЕ імплементовано)

### Концепція

Замість одного loop з LLM кожен цикл — два контури:

**Watchdog (1 хв, алгоритмічний)**
- Запускається щохвилини
- Пише market snapshot в DB (завжди, ~11.5k rows/day для 8 пар)
- Моніторить позиції: SL intact? TP intact? P&L drift?
- Зберігає entry thesis з DB (`trade_executions.entry_thesis`)
- LLM виклик тільки при anomaly (volume spike >3x, price move >2%/хв, OI стрибок)
- Може override Brain якщо бачить різке погіршення — "second opinion" через дешеву модель

**Brain (10-60 хв, LLM)**
- Як зараз TradingLoop.runOnce() — повний аналіз
- Інтервал динамічний: LLM сам каже `next_check_minutes` (min 10, функція вже є)
- Отримує aggregated summary від Watchdog: "за 10 хв BTC +0.3%, vol падає, позиція +6%->+2%, SL intact"
- Raw snapshots в DB для dashboard, summary в промпт (економія токенів)
- Entry thesis persistence: Brain бачить "BTC LONG entry thesis: bullish trend + vol 1.37x. SL: 71,274. TP: 78,023. Current: -4.5%. SL NOT hit."

### Узгоджені рішення

1. Watchdog = спостерігач + emergency exit + anomaly LLM (варіант 2-3)
2. Snapshot кожну хвилину завжди (варіант 1 — ~11.5k rows/day, DB витримає)
3. Brain отримує aggregated summary + raw в DB (варіант 3)
4. Entry thesis в DB `trade_executions` (варіант 1 — DB як source of truth)
5. Brain динамічний: min 10 хв, може бути 30-60 хв якщо сам скаже (функція вже є)

### Що це вирішує

| Проблема сьогодні | Як dual-loop фіксить |
|-------------------|---------------------|
| LLM не знає про SL/TP | Watchdog передає в summary: "SL at 71,274, NOT hit" |
| Немає entry thesis | Entry thesis зберігається в DB, Brain бачить кожен цикл |
| LLM паніканує від drawdown | Brain рідше (10+ хв), Watchdog алгоритмічний — без паніки |
| Бот "передумує" щоциклу | Brain не може закрити позицію яку щойно відкрив (min hold time) |
| 8-хвилинні позиції | Watchdog тримає, Brain ревалює через 10 хв — не через 2 |

---

## 5. Інші знахідки

### SL API Error (11:10)
```
"SL failed: Order type not supported for this endpoint. Please use the Algo Order API endpoints instead."
```
Код вже використовує `submitNewAlgoOrder` (orders.ts:57). Ця помилка виникла 5 разів о 11:10 для batch ордерів. Пізніше (12:29+) SL ставився успішно. Можливо Binance rate limit або тимчасова проблема. Варто додати retry logic для SL placement.

### False Positive з аудиту
`setStartBalance` called every cycle — НЕ баг. `SessionMemory.setStartBalance()` має guard `if (state.start_balance === undefined)` (session.ts:52).

### Production metrics (2026-03-05)
- Start balance: $186
- End balance: ~$180
- Session PnL: ~-$6
- Trades: 6 LONG entries, 3 LLM CLOSE, 2 order failures, 1 open (XRP)
- Loss streak: 5
- Regime: BullTrend -> Breakout
- MemoryReview triggered: yes (wrote self-reflection about BTCUSDT-only strategy)
