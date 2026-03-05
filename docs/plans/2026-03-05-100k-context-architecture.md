# 100k Context Architecture: The LLM-CPU-LLM Pipeline

## Vision
To conquer the noisy crypto market, the bot needs to transition from relying solely on aggregated indicators to analyzing raw, high-fidelity market data (OHLCV candles, order book ticks) alongside macroeconomic and news sentiment. This requires a large context window (~100k tokens) and a disciplined, structured reasoning process (Chain of Thought via a Mandatory Checklist).

## Core Concepts & Components

### 1. The LLM-CPU-LLM Flow
Instead of a single monolithic LLM call, the decision process is split to balance deep analysis with strict execution rules:
*   **LLM (Analysis & Synthesis):** The primary LLM ingests the massive 100k context (raw candles, order book, news, macro). Its *only* job is to analyze the data and populate a detailed, structured JSON "Checklist" (the pre-flight assessment). It does *not* make the final trade execution decision.
*   **CPU (Validation & Logic):** The deterministic code (CPU) takes the LLM's JSON Checklist output and evaluates it against hardcoded rules (e.g., if `liquidation_sweep_detected` is true AND `macro_risk_score` > 7, then proceed). It can also handle the `regime_override` logic here.
*   **LLM (Execution Formatting - Optional):** If the CPU rules pass, a smaller, faster LLM (or even deterministic formatting) is used to translate the approved strategy into the final `TradeDecision` payload (entry, SL, TP, leverage).

### 2. The Mandatory CoT Checklist
The primary LLM must output a strict JSON structure analyzing specific market factors *before* any trade can be considered. This forces the model into a rigorous Chain of Thought, preventing hallucinations and skipped steps.

**Example Checklist Criteria:**
*   `macro_risk_score` (1-10)
*   `liquidation_sweep_detected` (boolean)
*   `funding_anomaly_present` (boolean)
*   `order_book_imbalance_ratio` (number)
*   `news_catalyst_strength` (1-10)
*   `regime_override_suggestion` (string / null)

### 3. Data Ingestion: Raw vs. Aggregates
*   **Raw Data Pipeline:** Feed the LLM raw arrays of the last 500 OHLCV candles and significant order book snapshots. This allows the LLM to identify price action patterns (pin bars, flags, fakeouts) that indicators blur.
*   **Summarized Context:** To prevent context bloat, news and macroeconomic data should be pre-summarized (CPU or smaller LLM) before being fed into the primary 100k context.

### 4. The Role of the "Soul"
The bot's memory (Soul) serves as a reflective mechanism, not a paranoid constraint. The LLM is fed the recent `DecisionJournal` entries to learn from patterns (e.g., "I see 3 consecutive losses buying breakouts; risk of fakeouts is high; waiting for confirmed range").

## Implementation Phases

**Phase 1: Architecture refactoring (Data Prep)**
*   Enhance `src/binance/market-data.ts` to fetch and format larger sets of raw candles (e.g., 500 1h candles).
*   Create a mechanism to serialize order book depth into a token-efficient string format for the prompt.

**Phase 2: The CoT Checklist Schema**
*   Define the exact Typescript interfaces for the mandatory JSON checklist.
*   Rewrite the system prompts to demand *only* this JSON output, strictly prohibiting conversational filler.

**Phase 3: The Pipeline Logic (`src/trading-loop.ts`)**
*   Refactor the `TradingLoop` to await the LLM's Checklist JSON.
*   Implement the CPU-side logic to evaluate the checklist against the `MarketRegime` and `FilterProfiles`.

**Phase 4: Optimization & Token Management**
*   Monitor token usage for the 100k context.
*   Implement summarization pipelines for non-critical data to keep the context focused on raw price action and immediate catalysts.
