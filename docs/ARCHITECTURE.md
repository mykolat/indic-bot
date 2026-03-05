# Architecture — Indic Bot

## Overview

Indic Bot is an automated crypto futures trading system that combines multi-agent LLM-based analysis with hard-coded risk guardrails. It trades on Binance Futures using a hybrid decision-making approach: autonomous agents propose trades based on multi-timeframe technical analysis, news, macro data, and long-term episodic memory, while code-enforced guardrails prevent catastrophic risk.

## Trading Philosophy

- **Multi-timeframe confirmation**: 1h for timing, 4h for direction. Both must align for full-size entries.
- **Confluence-based entry**: Need 3+ of 5 factors (EMA alignment, RSI zone, VWAP, volume, news/macro catalyst).
- **Consensus-driven (Swarm)**: Operates a multi-agent swarm for complex regimes and high-volatility scenarios, gathering consensus between multiple persona-driven models before executing.
- **Memory-augmented (RAG)**: Retrieves historical similar market structures and past trade performance using Episodic Graph RAG (Embeddings + Cosine Similarity).
- **Confidence scoring**: Agents rate each decision 1-100. Below `minConfidence` (default 55) = auto-rejected.
- **Adaptive risk (Shark Mode)**: Position sizing and leverage automatically adapt to 5 identified market regimes.

## Component Diagram

```text
Config Sources
  ├─ config.yaml ── trading params (git-versioned, AI-writable)
  └─ .env ───────── secrets only (API keys, tokens)
       │
       ▼
Data Layer (Market & Intelligence)
  ├─ MarketData (Binance API: Candles, Funding, OI, L/S)
  ├─ Indicators (1h/4h: RSI, EMA, MACD, Bollinger, VWAP, Volume)
  ├─ News Layer (Max Info Pipe: CryptoPanicClient, RSS)
  ├─ Macro Data (Fear & Greed, Yahoo Finance)
  └─ Episodic Memory (EpisodicStore + EmbeddingClient for Local RAG)
       │
       ▼
Prompt Builder & Context Injection
  ├─ System constraints (strategy rules, confluence checklist)
  ├─ Distilled Layer 1 Info (News & Macro summaries)
  └─ Historical Trade Graph Context (similar past setups)
       │
       ▼
Intelligence Layer (Multi-Agent Swarm & Core)
  ├─ Layer 1 Swarm Consensus (Activated for complexity/high-volatility)
  │    ├─ Core Persona (Primary Data Analyst)
  │    ├─ GrokClient Persona (Real-time Event Verifier/Contrarian)
  │    └─ Other specialized personas
  ├─ Layer 1 Single Agent (Core - normal operation)
  ├─ Layer 2 FallbackLLM (Minimal API - HOLD/CLOSE only)
  └─ Layer 3 Rule-based (Emergency SL/TP reliance)
       │
       ▼
Risk Manager (manager.ts)
  ├─ Confidence check (min 55)
  ├─ Leverage / position size limits & 4h trend confirmation
  ├─ Fear & Greed cap / Session loss scaling
  └─ Duplicate position & Max loss shutdown guardrails
       │
       ▼
Order Executor (orders.ts)
  ├─ MARKET entry → STOP_MARKET SL → TAKE_PROFIT_MARKET TP
  └─ CLOSE = MARKET reduceOnly with exact position size
```

## Data Flow Per Cycle

1. **Fetch**: Market snapshots (candles, funding, OI, order book).
2. **Compute**: Technical indicators (1h + 4h).
3. **Auto-exit & Refresh**: Close stale positions; refresh Max Info Pipe (CryptoPanic, RSS) and macro data.
4. **Memory Retrieval**: `EpisodicAgent` queries `EpisodicStore` via `EmbeddingClient` to find past similar setups and trade learnings (Graph RAG).
5. **Context Building**: Build enriched prompts with data narratives, distilled Layer 1 reports, past trade context, and session P&L.
6. **LLM Execution (Swarm or Single)**: 
   - If regime requires or Swarm mode active, `SwarmAgent` coordinates parallel persona analysis (including `GrokClient` for xAI validation) and computes a weighted consensus.
   - Otherwise, Single LLM processes the state.
7. **Validate**: Each decision flows through the Risk Manager (confidence, leverage, exposure, guardrails).
8. **Execute & Log**: Approved trades executed on Binance; everything logged.
9. **Memory Storage**: Trade outcomes and dynamic learnings injected back into the RAG `EpisodicStore` and `soul.md`.

## Risk Management

### Hard Guardrails (code-enforced, LLM cannot bypass)

| Guardrail | Trigger | Action |
|-----------|---------|--------|
| Confidence check | `confidence < minConfidence` (55) | Reject trade |
| 4h trend mismatch | LONG in bearish 4h, confidence < 80 | Reject trade |
| F&G Leverage Cap | F&G < 25 or > 85, leverage > cap (10x)| Reject trade |
| Session drawdown | Drawdown >= 5% / 10% | Halve max / Cap to 5x & 25% size|
| Duplicate pos/SL | Same pair & direction / SL fails | Reject / Close |
| Max loss shutdown | Session P&L <= -(maxLossPct% x balance) | Stop bot completely |

### Soft Rules & Regimes (Shark Mode)
Adaptive market regime detection operates across 5 regimes (Bull, Bear, Range, Breakout, Capitulation) to adjust leverage caps, position sizing, and indicator filters.

## LLM Resilience & Multi-Agent Structure

The bot never trades blind. The intelligence layer is highly robust and relies on multi-agent consensus and structured fallbacks:

### Primacy: Multi-Agent Swarm (`SwarmAgent`)
- Coordinates multiple distinct LLM personalities (e.g., standard analyst, Grok contrarian).
- Parses parallel completions and aggregates them into a weighted mathematical consensus.

### Fallback Layers
- **Layer 1 Single Agent**: Primary standalone LLM processing.
- **Layer 2 Minimal Agent**: Fallback to a secondary model if primary API fails. Returns HOLD/CLOSE only.
- **Layer 3 Rule-based**: Pure code logic executing current stop-losses. 
- **Circuit Breaker**: Skips cycles if Binance API hits continuous `Promise.allSettled` failures.

## Memory & Soul System

The bot maintains a persistent hybrid identity and memory system that spans flat files and embedded graph retrieval (`RAG`).

### Components

| Component | File | Purpose |
|-----------|------|---------|
| EpisodicAgent & Store | `src/llm/episodic-agent.ts`, `src/memory/episodic-store.ts` | Graph RAG long-term memory via embeddings |
| EmbeddingClient | `src/llm/embedding-client.ts` | Cosine similarity for past similar events |
| SoulKeeper | `src/memory/soul-keeper.ts` | Handles flat-file `soul.md` logging |
| SoulReviewAgent | `src/memory/soul-review.ts` | Meta-reflection every ~20 cycles |

## Configuration

Config split implemented: secrets in `.env`, trading params in `config.yaml` (git-versioned). 
`loadConfig()` merges both sources — secrets from environment variables, everything else from `config.yaml` with hardcoded defaults.

### Secrets (`.env` only)
Requires standard `BINANCE_*`, `OPENAI_*` APIs, and new additions for the Swarm/Info Stack:
- `XAI_API_KEY`: For `GrokClient` (xAI) external validation and contrarian inputs
- `APIFY_API_TOKEN`: For CryptoPanic Max Info Pipe integration
