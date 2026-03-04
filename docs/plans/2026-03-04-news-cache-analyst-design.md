# News Cache + Analyst Agent Design

**Date:** 2026-03-04
**Goal:** Replace per-cycle Apify calls with a cached news system + separate LLM analyst agent that converts raw headlines into structured predictions. Trading LLM receives clean signals, not raw text.

---

## Problem

Current state:
- Apify Actor runs every 60s → ~1440 calls/day, ~$1.44/day for identical data
- Only 10 of 53+ results shown to LLM
- No deduplication — LLM re-reads same headlines hundreds of times
- No structured signal extraction — raw text burns tokens

---

## Data Flow

```
Apify fetch trigger (2x/day schedule OR FETCH_NEWS from trading LLM):
  → CryptoPanicClient.fetchNews(limit=100)
  → NewsAnalystAgent.analyze(items)   ← separate Codex call
  → { market_summary, top_signals, overall_sentiment, risk_events }
  → NewsCache.save({ items, analysis, fetchedAt, analyzedAt })
  → NewsCache.appendHistory(...)

Every trading cycle:
  → NewsCache.load() → pass analysis to LLM prompt
  → Trading LLM sees market_summary + top_signals only
  → If LLM returns action: "FETCH_NEWS" → trigger refresh → re-analyze
```

---

## Storage

### `~/.indic-bot/news-cache.json`

```json
{
  "items": [...up to 100 raw CryptoNews...],
  "fetchedAt": "2026-03-04T14:00:00Z",
  "analysis": {
    "market_summary": "BTC rallying on ETF inflows ($8.2B this week). Fed minutes bearish macro.",
    "top_signals": [
      {
        "coins": ["BTC"],
        "direction": "bullish",
        "importance": 9,
        "timeframe": "short",
        "catalyst": "ETF record inflows $8.2B",
        "reasoning": "Institutional demand surge, supply squeeze likely",
        "price_impact": "high",
        "expires_hours": 48,
        "source_count": 12,
        "conflicting": false
      },
      {
        "coins": ["ETH", "SOL"],
        "direction": "neutral",
        "importance": 5,
        "timeframe": "medium",
        "catalyst": "No major catalyst",
        "reasoning": "Range-bound, watching BTC lead",
        "price_impact": "low",
        "expires_hours": 24,
        "source_count": 3,
        "conflicting": true
      }
    ],
    "overall_sentiment": "cautiously_bullish",
    "macro_signals": {
      "fed_stance": "hawkish",
      "risk_appetite": "moderate",
      "dominance_trend": "btc_gaining"
    },
    "risk_events": ["FOMC meeting tomorrow", "BTC options expiry Friday", "CPI data Wednesday"]
  },
  "analyzedAt": "2026-03-04T14:00:08Z"
}
```

### `~/.indic-bot/news-history.jsonl`

Append-only on every fetch. Full record for correlation analysis:
```json
{"fetchedAt": "...", "analyzedAt": "...", "itemCount": 87, "analysis": {...}, "items": [...]}
```

---

## New Modules

### `src/news/news-cache.ts`

```typescript
export interface NewsSignal {
  coins: string[];
  direction: 'bullish' | 'bearish' | 'neutral';
  importance: number;        // 1-10
  timeframe: 'short' | 'medium' | 'long';
  catalyst: string;          // one-line trigger
  reasoning: string;         // analysis
  price_impact: 'high' | 'medium' | 'low';
  expires_hours: number;     // how long signal stays relevant
  source_count: number;      // how many articles support this
  conflicting: boolean;      // mixed signals on this coin
}

export interface NewsAnalysis {
  market_summary: string;
  top_signals: NewsSignal[];
  overall_sentiment: string;
  macro_signals: {
    fed_stance: string;
    risk_appetite: string;
    dominance_trend: string;
  };
  risk_events: string[];
}

export interface NewsCacheState {
  items: CryptoNews[];
  fetchedAt: string;
  analysis: NewsAnalysis | null;
  analyzedAt: string | null;
}

export class NewsCache {
  // load() — read ~/.indic-bot/news-cache.json, return null if missing
  // save(state) — persist to disk
  // shouldRefresh(intervalHours) — true if fetchedAt is older than interval
  // appendHistory(state) — append to ~/.indic-bot/news-history.jsonl
  // getAnalysis() — returns analysis or null
}
```

### `src/news/news-analyst.ts`

```typescript
export class NewsAnalystAgent {
  constructor(private llmClient: LLMClient) {}

  async analyze(items: CryptoNews[]): Promise<NewsAnalysis>
  // Calls Codex with focused system prompt:
  // "You are a crypto news analyst. Given headlines, return JSON with:
  //  market_summary (2-3 sentences), top_signals per coin (importance 1-10,
  //  direction, timeframe, reasoning), overall_sentiment, risk_events"
}
```

---

## Changes to Existing Files

### `src/news/cryptopanic.ts`
- Change `items.slice(0, 10)` → `items.slice(0, limit)` where limit comes from config

### `src/config.ts`
```typescript
trading: {
  // ...existing...
  newsRefreshIntervalH: number;  // NEWS_REFRESH_INTERVAL_H=12
  newsMaxItems: number;           // NEWS_MAX_ITEMS=100
}
```

### `src/trading-loop.ts`
On each cycle:
1. `newsCache.shouldRefresh(config.newsRefreshIntervalH)` → if true, fetch + analyze
2. Pass `newsCache.getAnalysis()` to `llm.analyze()`
3. If any decision has `action === 'FETCH_NEWS'` → trigger refresh, skip to next cycle

### `src/llm/prompts.ts`
Replace raw news section with:
```
## News Analysis
Sentiment: cautiously_bullish
Summary: BTC rallying on ETF inflows...
Signals: BTC bullish (9/10, short-term) | ETH neutral (5/10)
Risk: FOMC tomorrow
```

### `src/index.ts`
- Create `NewsCache`, `NewsAnalystAgent`
- Pass both to `TradingLoop`

---

## Config

```env
NEWS_REFRESH_INTERVAL_H=12   # fetch 2x/day minimum
NEWS_MAX_ITEMS=100            # items per Apify fetch
```

---

## FETCH_NEWS Action

Add to system prompt constraints:
> If you need fresher news context, include one decision: `{ "pair": "_meta", "action": "FETCH_NEWS", "reasoning": "..." }`

Trading loop intercepts `pair === "_meta"` before risk check, triggers refresh.

---

## Testing

- `tests/news/news-cache.test.ts` — shouldRefresh logic, load/save, appendHistory
- `tests/news/news-analyst.test.ts` — mock LLMClient, verify output schema
