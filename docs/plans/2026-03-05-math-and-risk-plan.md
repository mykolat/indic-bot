# Math & Risk Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement bulletproof math for indicators (Wilder's RSI), accurate execution mechanics (SL/TP anchored to fill price), and institutional risk management (Continuous Rolling Drawdown, Volatility Targeting Sizing) based on the Ultrea Analysis.

**Architecture:** 
1. `indicators/technical.ts`: Update RSI to use Wilder's Smoothing (RMA) instead of Cutler's (SMA) for parity with Binance/TradingView.
2. `binance/orders.ts` & `trading-loop.ts`: Anchor SL/TP to actual execution `fillPrice` rather than the theoretical trigger price. Implement dynamic spread tolerance.
3. `risk/manager.ts` & `portfolio/state.ts`: Implement a persistent High Water Mark (HWM) for continuous rolling drawdown tracking across PM2 restarts.
4. `risk/sizing.ts` (New module): Implement Volatility Targeting (VT) sizing using ATR to dynamic position size.

**Tech Stack:** TypeScript ESM, Vitest, existing risk and indicator frameworks.

---

### Task 1: Wilder's RSI (RMA)
Currently, RSI uses Cutler's method (Simple Moving Average of gains/losses). We need to switch to Wilder's Smoothing Method (RMA).

*   **Files:** `src/indicators/technical.ts`, `tests/indicators/technical.test.ts`
*   **Action Plan:**
    1.  Write a failing test comparing the new RSI output against known TradingView/Binance values (or just assert standard Wilder's calculation).
    2.  Implement RMA (Running Moving Average) in `computeRSI`.
    3.  Verify all indicator tests pass.

### Task 2: Execution Anchoring (Fill Price vs Trigger Price)
Currently, SL/TP are placed immediately based on the predicted entry price. This ignores slippage.

*   **Files:** `src/binance/orders.ts`, `src/trading-loop.ts`, `tests/binance/orders.test.ts`
*   **Action Plan:**
    1.  Update `submitNewOrder` mock in tests to simulate returning a `fills` array or an `avgPrice`.
    2.  Refactor `execute()` in `orders.ts` to first execute the MARKET order, await the response, and extract the actual `avgPrice` (or calculate from `fills`).
    3.  Calculate the `stopPrice` for SL and TP based on this actual *fill price*, not the initial `price`.
    4.  Update tests to verify the stop levels are calculated off the mocked fill price.

### Task 3: Continuous Rolling Drawdown (Persistent High Water Mark)
`SessionPnl` resets on restart. We need a persistent record of the account's High Water Mark (HWM) to track true drawdown.

*   **Files:** `src/portfolio/state.ts` (or equivalent persistent storage like SQLite/JSON), `src/risk/manager.ts`, `tests/risk/manager.test.ts`
*   **Action Plan:**
    1.  Create a lightweight mechanism (e.g., `state.json` or existing SQLite DB) to store `highWaterMarkUsd`.
    2.  In the main loop/portfolio sync, update `highWaterMarkUsd` if current balance > `highWaterMarkUsd`.
    3.  In `risk/manager.ts`, calculate `currentDrawdownPct = (highWaterMarkUsd - currentBalance) / highWaterMarkUsd * 100`.
    4.  If `currentDrawdownPct >= config.maxDrawdownPct`, trigger shutdown.
    5.  Write explicit tests for HWM persistence and drawdown calculation across simulated restarts.

### Task 4: Volatility Targeting (VT) Position Sizing
Static sizing (e.g., 10%) is risky in high vol. Size should scale inversely with ATR.

*   **Files:** `src/risk/sizing.ts` (new), `src/trading-loop.ts`, `tests/risk/sizing.test.ts`
*   **Action Plan:**
    1.  Define a target risk per trade (e.g., risk 1% of account capital).
    2.  Calculate SL distance in % (e.g., based on ATR or predefined SL).
    3.  `PositionSize = (AccountBalance * TargetRiskPct) / SL_DistancePct`.
    4.  Cap the size at `config.maxPositionPct` to ensure we don't over-leverage in extremely low vol scenarios.
    5.  Integrate this into the `TradeDecision` logic where the agent's requested `size_pct` is capped/overridden by the VT Engine.
