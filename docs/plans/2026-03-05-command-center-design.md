# Trading Command Center — Design

**Date:** 2026-03-05
**Goal:** Transform bot from single-source/single-LLM into a multi-source, multi-agent Trading Command Center with real-time news, social signals, on-chain data, and Grok grounding.

---

## Problem

Current state:
- **1 news source** — CryptoPanic via Apify (frequently timeouts)
- **1 macro source** — Yahoo Finance via Apify (404 broken)
- **1 sentiment** — Fear & Greed index
- **1 LLM call** — single Codex call does everything: analyze news, macro, technicals, make decisions
- **No social signals** — no Twitter, Reddit, Telegram
- **No on-chain data** — no whale movements, exchange flows
- **No grounding** — no fact-checking of news claims

Result: LLM makes decisions on thin data, often just technicals + F&G.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│            DATA COLLECTORS (parallel, async)           │
│                                                        │
│  Twitter Stream     News Aggregator    Arkham On-Chain  │
│  (crypto-twitter-   (crypto-news-      (whale txns)    │
│   tracker, SSE)      aggregator, RSS)                  │
│                                                        │
│  Reddit Intel       Macro (Yahoo)      Binance API     │
│  (reddit-intel)     (stock prices)     (OI, funding)   │
│                                                        │
│  Fear & Greed       CoinGecko          Grok X Intel    │
│  (alternative.me)   (volumes, mcap)    (X search)      │
└───┬──────────┬──────────┬───────────┬──────────┬───────┘
    │          │          │           │          │
┌───▼───┐ ┌───▼───┐ ┌───▼───┐  ┌───▼───┐ ┌────▼────┐
│ News  │ │Macro  │ │On-Chain│  │Social │ │  Grok   │
│Analyst│ │Analyst│ │Analyst │  │Analyst│ │Grounder │
│(Codex │ │(Codex │ │(Codex  │  │(Codex │ │(Codex   │
│ low)  │ │ low)  │ │ low)   │  │ low)  │ │ low)    │
└───┬───┘ └───┬───┘ └───┬───┘  └───┬───┘ └────┬────┘
    │         │         │          │           │
    ▼         ▼         ▼          ▼           ▼
┌──────────────────────────────────────────────────────┐
│           STRUCTURED BRIEFINGS → SQLite               │
│  news_brief │ macro_brief │ chain_brief │ social_brief│
│                    │ grounding_report                  │
└────────────────────┬─────────────────────────────────┘
                     │
                ┌────▼──────┐
                │   CHIEF   │
                │  TRADER   │ ← soul.md + all briefings
                │  (Codex   │
                │  medium)  │
                └────┬──────┘
                     │
                ┌────▼──────┐
                │ DECISIONS │
                │ + next_   │
                │ check_min │
                └───────────┘
```

**All LLM calls use Codex** (existing OAuth auth). No additional LLM API keys needed.
- **5 Analyst agents**: Codex low reasoning — fast, cheap briefings
- **1 Chief Trader**: Codex medium reasoning — deeper analysis for trade decisions

---

## Data Sources

### Phase 1: News (replace broken CryptoPanic)

| Source | Apify Actor | Data | Cost | Refresh |
|--------|------------|------|------|---------|
| Crypto News Aggregator | `code-node-tools/crypto-news-aggregator` | RSS from 20+ sources (CoinDesk, The Block, Decrypt, CoinTelegraph) | $0.002/article | Every 20 min |
| Web3 News Intel | `visita/cyber-security-ai-news-intelligence` | CoinDesk, The Defiant + AI sentiment | $0.01/article | Every 20 min |
| CryptoPanic (fallback) | `piotrv1001~cryptopanic-news-scraper` | Aggregated headlines + votes | existing | Fallback only |

### Phase 2: Social + Grounding

| Source | Apify Actor / API | Data | Cost | Refresh |
|--------|------------|------|------|---------|
| Twitter Crypto Stream | `muhammetakkurtt/crypto-twitter-tracker` | Real-time tweets from 1000+ KOLs, VCs, traders | $0.05/event | SSE stream / every 5 min |
| Grok X Intelligence | `constant_quadruped/grok-x-intelligence` | X search powered by Grok AI, sentiment, trends | FREE | On-demand (grounding) |
| Reddit Intelligence | `actor_researcher.48/reddit-intelligence-ai-v1` | r/cryptocurrency, r/bitcoin sentiment | $0.05/analysis | Every 1h |

### Phase 3: On-Chain

| Source | Apify Actor / API | Data | Cost | Refresh |
|--------|------------|------|------|---------|
| Arkham Intelligence | `muhammetakkurtt/arkham-intelligence-wallet-transfers-swaps-scraper` | Whale transfers with entity labels | $0.003/wallet | Every 30 min |
| CoinGecko | Free API | Market caps, volumes, 24h changes | FREE | Every cycle |
| Binance API | Already integrated | OI, funding rate, L/S ratio | FREE | Every cycle |

### Always-On (existing)

| Source | API | Data | Refresh |
|--------|-----|------|---------|
| Fear & Greed | alternative.me | 0-100 index | Every cycle |
| Macro (Yahoo) | Apify actor (fix needed) | DXY, VIX, S&P, Gold, Oil | Every 3h |
| Binance Market Data | Already integrated | Candles, OB depth, funding | Every cycle |

---

## Agent Specifications

### 1. News Analyst (Codex low)

**Input:** Headlines from RSS aggregator + Web3 intel
**System prompt focus:** Classify by importance (1-10), direction, catalyst, timeframe, affected coins. Cross-reference multiple sources for confidence.
**Output:**
```json
{
  "market_summary": "...",
  "top_signals": [
    { "coins": ["BTC"], "direction": "bullish", "importance": 9,
      "catalyst": "SEC approves spot ETF", "timeframe": "short",
      "source_count": 3, "needs_grounding": true }
  ],
  "overall_sentiment": "bullish",
  "risk_events": ["FOMC tomorrow"]
}
```
**Refresh:** Every 20 min (or on-demand via FETCH_NEWS)

### 2. Macro Analyst (Codex low)

**Input:** Yahoo Finance macro snapshots + BTC dominance
**System prompt focus:** Cross-asset correlation: DXY↑ = crypto↓, VIX↑ = risk-off, S&P↑ = risk-on
**Output:**
```json
{
  "macro_summary": "...",
  "risk_environment": "risk_off",
  "crypto_correlation_signal": "bearish",
  "key_levels": ["DXY 104 resistance", "VIX above 20"],
  "refreshed_at": "..."
}
```
**Refresh:** Every 3h (existing)

### 3. On-Chain Analyst (Codex low)

**Input:** Arkham whale transfers, Binance OI/funding, CoinGecko volumes
**System prompt focus:** Exchange inflows (selling pressure), whale accumulation, liquidation risk from OI buildup, funding rate extremes
**Output:**
```json
{
  "whale_activity": "accumulation",
  "exchange_flow": "net_outflow",
  "liquidation_risk": "moderate",
  "signals": [
    { "type": "whale_buy", "coin": "BTC", "amount_usd": 50000000,
      "entity": "unknown_whale", "significance": "high" }
  ],
  "funding_alert": "crowded_longs"
}
```
**Refresh:** Every 30 min

### 4. Social Analyst (Codex low)

**Input:** Twitter crypto stream + Reddit sentiment
**System prompt focus:** Narrative shifts, KOL consensus, retail FOMO/panic indicators, trending coins, meme coin alerts
**Output:**
```json
{
  "twitter_sentiment": "cautiously_bullish",
  "trending_narratives": ["ETF inflows", "SOL DeFi summer"],
  "kol_consensus": { "BTC": "bullish", "ETH": "neutral" },
  "retail_fomo_level": "low",
  "notable_tweets": [
    { "author": "@CryptoWhale", "followers": 500000,
      "summary": "BTC breaking 100k this week", "engagement": "high" }
  ]
}
```
**Refresh:** Every 5-10 min

### 5. Grok Grounder (Codex low)

**Input:** Claims from News Analyst and Social Analyst that have `needs_grounding: true`
**Method:** Calls `grok-x-intelligence` Apify actor with claim as query, gets real X search results
**System prompt focus:** Fact-check against X data. Is this news real? Multiple independent sources? Any contradictions?
**Output:**
```json
{
  "verifications": [
    { "claim": "SEC approves spot ETF",
      "verified": true,
      "confidence": 0.95,
      "sources": ["@SECGov tweet", "@Bloomberg", "@CoinDesk"],
      "contradictions": [] },
    { "claim": "Binance delisting SOL",
      "verified": false,
      "confidence": 0.1,
      "sources": [],
      "contradictions": ["Only from anonymous account", "No official source"] }
  ]
}
```
**Trigger:** On-demand when analysts flag claims

### 6. Chief Trader (Codex medium)

**Input:** All 5 briefings + technicals + portfolio + soul.md
**System prompt:** Existing trading prompt (enhanced with briefing sections)
**Output:** Existing `decisions[]` + `next_check_minutes`
**Reasoning level:** Medium — weighs conflicting signals, evaluates risk/reward with deeper analysis

---

## Data Flow per Cycle

```
1. Parallel data fetch (non-blocking):
   - Binance market data (every cycle)
   - Fear & Greed (every cycle)
   - News refresh (if stale, every 20 min)
   - Twitter stream drain (every 5 min)
   - On-chain refresh (every 30 min)
   - Macro refresh (every 3h)
   - Reddit refresh (every 1h)

2. Parallel analyst calls (if fresh data available):
   - News Analyst → news_brief
   - Social Analyst → social_brief
   - On-Chain Analyst → chain_brief
   (Macro Analyst runs on its own 3h schedule)

3. Grounding (if needed):
   - Grok Grounder verifies flagged claims

4. Chief Trader:
   - Receives: technicals + all briefings + soul.md
   - Returns: decisions[] + next_check_minutes

5. Risk Manager → Order Executor (unchanged)
```

---

## Implementation Phases

### Phase 1: Fix + Expand News (~1 week)
- Replace CryptoPanic with `crypto-news-aggregator`
- Add `grok-x-intelligence` as grounding source
- News Analyst becomes dedicated Codex low call
- Grounding pipeline for high-importance claims

### Phase 2: Social Signals (~1 week)
- Add Twitter stream via `crypto-twitter-tracker`
- Add Reddit via `reddit-intelligence-ai-v1`
- Social Analyst agent
- Integrate social_brief into Chief Trader prompt

### Phase 3: On-Chain Intelligence (~1 week)
- Add Arkham whale tracking
- Add CoinGecko market data enrichment
- On-Chain Analyst agent
- Integrate chain_brief into Chief Trader prompt

### Phase 4: Chief Trader Upgrade (~3 days)
- Switch Chief Trader to medium reasoning
- Restructure prompt: briefing sections instead of raw data
- Smaller, more focused prompt (briefings are pre-digested)

---

## Storage

All briefings stored in SQLite (`~/.indic-bot/briefings.db`):
- `briefings` table: `(type, content_json, created_at, cycle_id)`
- Enables: audit trail, pattern detection, soul review analysis
- Rotation: keep last 7 days, archive older

---

## Budget Estimate (~$70-100/month)

| Component | Monthly Cost |
|-----------|-------------|
| Apify (news aggregator) | ~$10-15 |
| Apify (Twitter stream) | ~$15-25 |
| Apify (Arkham on-chain) | ~$5-10 |
| Apify (Reddit intel) | ~$5-10 |
| Apify (Grok X intel) | FREE |
| CoinGecko | FREE |
| Codex (all agents) | Already paid |
| **Total** | **~$35-60 Apify + existing Codex** |

---

## Config Addition (config.yaml)

```yaml
command_center:
  news:
    refreshIntervalMin: 20
    sources: [crypto-news-aggregator, web3-news-intel]
    fallback: cryptopanic
  social:
    twitter:
      refreshIntervalMin: 5
      actor: muhammetakkurtt/crypto-twitter-tracker
    reddit:
      refreshIntervalMin: 60
      actor: actor_researcher.48/reddit-intelligence-ai-v1
  onchain:
    refreshIntervalMin: 30
    actor: muhammetakkurtt/arkham-intelligence-wallet-transfers-swaps-scraper
    wallets: [] # tracked whale wallets
  grounding:
    actor: constant_quadruped/grok-x-intelligence
    minImportanceForGrounding: 7
  macro:
    refreshIntervalH: 3
  analysts:
    reasoning: low    # for all analyst agents
  trader:
    reasoning: medium # for Chief Trader
```

---

## Key Design Decisions

1. **All Codex** — single auth flow, no additional LLM API keys
2. **Analysts = low reasoning, Trader = medium** — cost efficiency where it matters
3. **Briefings not raw data** — Chief Trader gets pre-digested summaries → smaller prompt, better decisions
4. **Grounding is on-demand** — only for claims with importance >= 7, not every headline
5. **Phased rollout** — each phase independently useful, no big-bang migration
6. **SQLite for everything** — briefings, news, audit trail. Simple, no external DB needed
