# 33k Context Architecture: The LLM-CPU-LLM Pipeline

## Vision
To conquer the noisy crypto market, the bot needs to transition from relying solely on aggregated indicators to analyzing raw, high-fidelity market data (OHLCV candles, order book ticks) alongside macroeconomic and news sentiment. This requires a large context window (~33k tokens) and a disciplined, structured reasoning process (Chain of Thought via a Mandatory Checklist).

## Core Concepts & Components

### 1. The Multi-Agent LLM-CPU-LLM Flow
Instead of a single monolithic LLM call handling everything, the process is distributed:

*   **Stage 1: LLM Agents (Data Distillation):** Dedicated LLM agents process specialized chunks of the 33k context.
    *   *News Expert:* Reads RSS feeds and Twitter, outputs structured catalyst scores.
    *   *Macro Expert:* Analyzes funding rates, open interest, and traditional finance metrics.
    *   *Market Expert (Primary):* Synthesizes raw OHLCV and order book data with inputs from the other experts to populate a mandatory JSON Checklist.
*   **Stage 2: CPU (Validation & Logic):** Deterministic Typescript code evaluates the primary LLM's JSON Checklist against hardcoded rules (e.g., if `liquidation_sweep_detected` is true AND `macro_risk_score` > 7, then proceed). It also handles the `regime_override` logic.
*   **Stage 3: LLM (Execution Formulation):** If the CPU rules pass, a smaller, faster LLM translates the approved strategy into the final `TradeDecision` payload (entry, SL, TP, leverage).

### 2. The Mandatory CoT Checklist
The primary LLM must output a strict JSON structure analyzing specific market factors *before* any trade can be considered. This forces the model into a rigorous Chain of Thought, preventing hallucinations and skipped steps.

**Example Checklist Criteria:**
*   `macro_risk_score` (1-10)
*   `liquidation_sweep_detected` (boolean)
*   `funding_anomaly_present` (boolean)
*   `order_book_imbalance_ratio` (number)
*   `news_catalyst_strength` (1-10)
*   `regime_override_suggestion` (string / null)

### 4. Deep Reflection: The "Soul"
The bot's memory (`soul.md`) serves as a reflective mechanism and identity anchor, managed out-of-band by the `SoulKeeper`. It is *not* just a log of P&L; it is the bot's "experience" and "money consciousness".
*   **Identity & Lessons:** The LLM is fed continuous self-reflections (e.g., "I keep chasing breakout fakeouts; I need to wait for confirmed support").
*   **Performance Metrics:** The Soul tracks quantitative metrics (Win Rate, Profit Factor, Current Streak, Best/Worst Pair) that structurally influence the LLM's confidence weighting in the next cycle.
*   This context acts as a high-level guardrail, weighting the LLM's bias *before* it processes the raw market data.

### 5. Data Ingestion: Raw vs. Aggregates
*   **Raw Data Pipeline:** Feed the primary LLM raw arrays of the last 500 OHLCV candles and dense order book snapshots. This allows the LLM to identify price action nuances (pin bars, flags, liquidity sweeps) that indicators obscure.
*   **Summarized Context:** To respect the 33k limit and improve SNR (Signal-To-Noise Ratio), the CPU pre-assembles cleanly formatted summaries from the specialized agents (News/Macro) to feed alongside the raw price action.

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
*   Monitor token usage for the 33k context.
*   Implement summarization pipelines for non-critical data to keep the context focused on raw price action and immediate catalysts.
