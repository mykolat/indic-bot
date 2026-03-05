# AI Architecture & Data Filtering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a robust, hierarchical context pipeline for GPT-5.3 that treats the LLM as the ultimate "decision-maker" at the top of a pyramid, fed by highly structured, mathematically precise data from lower layers. We need to maximize the value of the 100k+ context window without overwhelming the model with unsorted "garbage".

**Architecture:** 
1. `data/context-builder.ts`: A centralized builder that constructs the prompt context using a "Pyramid" architecture: High Conviction math at the top, Medium signals in the middle, and Raw data at the bottom.
2. `market/orderbook-validation.ts`: A cross-validation layer that checks orderbook depth (Bid/Ask walls) to validate or invalidate alternative data (like whale movements).
3. `llm/prompts.ts`: Rewrite prompts to explicitly instruct GPT-5.3 to weigh the hierarchical data correctly and adopt regime-specific personas.
4. `agents/agent-orchestrator.ts`: Treat the system as a bottom-up AI hierarchy. Small scripts calculate math/indicators; middle layers structure it; the top-level GPT-5.3 acts as the final human-like decision maker.

**Tech Stack:** TypeScript ESM, Vitest, Binance Futures API.

---

### Task 1: Information Pyramid Context Builder
GPT-5.3 has a massive context window, but we must feed it logically sorted information.

*   **Files:** `src/data/context-builder.ts`, `tests/data/context-builder.test.ts`, `src/trading-loop.ts`
*   **Action Plan:**
    1.  Create `ContextBuilder` class that accepts inputs from Indicators, Portfolio, Orderbook Validator, and News/Alt Data.
    2.  Write a method `buildHierarchicalPrompt()` that formats the text:
        *   **Tier 1 (Hard Math/Critical):** Current Price, Fill-Anchored SL/TP targets, Portfolio Drawdown, Market Regime.
        *   **Tier 2 (Validation/Liquidity):** Orderbook Imbalance (Bid/Ask walls), Technical Indicator Confluence.
        *   **Tier 3 (Alternative/Context):** Recent News, Social Sentiment, On-Chain Whale data.
    3.  Integrate this builder into `trading-loop.ts` to replace the current unstructured prompt format.

### Task 2: Orderbook Cross-Validation Layer
Alternative data is noise without liquidity confirmation. We must provide the AI with orderbook truth.

*   **Files:** `src/market/orderbook-validation.ts`, `tests/market/orderbook-validation.test.ts`
*   **Action Plan:**
    1.  Write failing tests for `analyzeOrderbookDepth(symbol, depth)` that expect it to return a `LiquidityProfile` (BuyWall/SellWall distance and volume).
    2.  Implement the function using `binanceClient.getDepth()`.
    3.  Calculate the ratio of Bids vs Asks within a 0.5% and 1% radius of the current price.
    4.  Feed this `LiquidityProfile` directly into Tier 2 of the `ContextBuilder`.

### Task 3: Regime-Specific AI Personas
The LLM should adopt different trading styles based on the mathematical regime detected by our scripts.

*   **Files:** `src/llm/prompts.ts`, `tests/llm/prompts.test.ts`
*   **Action Plan:**
    1.  Update the system prompt generation to accept a `MarketRegime` enum.
    2.  If `BullTrend`: Inject instructions: "You are an aggressive trend-follower. Hold winners longer. Ignore minor bearish divergences."
    3.  If `Range`: Inject: "You are a cautious market-maker. Buy support, sell resistance. Take quick scalps. Tighten TP."
    4.  If `Capitulation`: Inject: "You are in extreme caution mode. Look for high-volume climax bottoms. Prioritize capital preservation."
    5.  Test prompt generation output for all regimes.

### Task 4: Context Sorting & Garbage Collection
Ensure the 100k context window is filled with *relevant* historical data, not just recent noise.

*   **Files:** `src/data/context-memory.ts` (New)
*   **Action Plan:**
    1.  Implement a sliding window of historical `TradeStory` events and major news that were *proven correct or incorrect* (feedback loop).
    2.  Sort this historical context by relevance (e.g., if currently in a `Range` regime, inject past `TradeStory` events from the last time we were in a `Range`).
    3.  Feed this sorted historical context into the prompt builder.

### Task 5: Final Verification
*   **Step 1:** Run the full test suite (`npx vitest run`).
*   **Step 2:** Run `npx tsc --noEmit` to ensure type safety.
*   **Step 3:** Perform a dry-run of the `trading-loop` on testnet to log the exact `ContextBuilder` output sent to GPT-5.3 and manually verify the "Information Pyramid" is perfectly formatted.
EOF
