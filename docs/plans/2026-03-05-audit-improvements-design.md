# Audit Improvements Design

## 1. Accurate PnL Tracking (Deposit/Withdrawal Safe)
**Problem:** The current `Session PnL` calculation strictly compares the first logged `balance` to the current `walletBalance`. Manual deposits/withdrawals skew this data massively (e.g., adding $155 makes the bot think it made $155 profit).
**Solution:** 
- Keep the overall Wallet Balance for reference.
- Calculate **Session Realized PnL** dynamically: Fetch all trades since the session start time (first timestamp in `performance.jsonl`) and sum their `realizedPnl`.
- Add **Session Unrealized PnL** (from current open positions).
- **Session Total PnL** = Realized + Unrealized. This makes the PnL 100% immune to external wallet deposits/withdrawals.

## 2. Market Regimes & "Shark Mode" Context
**Problem:** The audit currently shows no data about the environment the bot thinks it's operating in.
**Solution:**
- Incorporate the `classifyRegime` logic within the audit script (by quickly calculating indicators for BTCUSDT).
- Display the **Current Regime** (e.g., `BullTrend`, `Range`).
- Display the **Active Filter Profile** requirements (e.g., `Volume Must Be > 1.2x`, `Confluence > 2`).
- Show if the current market conditions are actually passing the filter profile, providing immediate clarity on why the bot might be skipping trades.

## 3. Layer 1 Expert Agents & Intellectual State
**Problem:** The audit doesn't show what the constituent agents (News, Macro) are thinking, only the final tokens used and generic stats.
**Solution:**
- Parse the recent analysis from the SQLite database/Cache for `News` and `Macro`.
- Output a condensed summary of the `MacroAnalysis` (Fed stance, bias) and the `NewsAnalysis` (top signals, needs grounding).
- Display the recent Grok Grounding verification intel if present in the Soul memory.

## 4. Enhanced Action Logs
**Problem:** `decisions.jsonl` are just counted.
**Solution:**
- Show the last 5 `RISK_REJECTED` reasons specifically.
- Group decisions to show specifically how many `LONG`/`SHORT` were requested vs. rejected vs. executed.

## Next Steps
This design resolves the inaccuracy in the PnL, and brings the audit script up to speed with the new 33k Context multi-agent architecture.
