# Audit Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Enhance `scripts/audit.ts` to compute PnL safely ignoring deposits, display Market Regimes, summarize News Agent intel, and enhance action logs.

**Architecture:** Modifies `scripts/audit.ts` to use trade history for session PnL instead of raw wallet delta; adds a new section for current Market Regime by fetching BTCUSDT candles and calculating indicators; adds risk rejection details.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Refactor Session PnL Calculation

**Files:**
- Modify: `scripts/audit.ts`

**Step 1: Write minimal implementation**
```typescript
// Modify `scripts/audit.ts`
// Find the "4. BOT LOGS SUMMARY" section where it reads performance logs.
// Instead of `const pnlUsd = currentWallet - startBalance;`, compute session realized PnL from trades since the bot started (perf[0].timestamp).
// Add Unrealized PnL to Realized PnL for accurate True Session PnL.
```

**Step 2: Run script to verify it works**
Run: `npm run audit:bot`

**Step 3: Commit**
```bash
git add scripts/audit.ts
git commit -m "feat: switch session PnL to trade-based calculation #gemini"
```

---

### Task 2: Display Market Regime & Filter Profile

**Files:**
- Modify: `scripts/audit.ts`

**Step 1: Write minimal implementation**
```typescript
// Import `classifyRegime`, `getFilterProfile`, `computeIndicators`, `fetchFearGreed`.
// Fetch 1h candles for BTCUSDT via `client.getKlines`.
// Call `computeIndicators`, `fetchFearGreed`, and then `classifyRegime`.
// Print out the Regime, Confidence, and 1-2 key parameters from the `getFilterProfile(regime)` (like Volume Min, Confluence Min).
```

**Step 2: Run script to verify it works**
Run: `npm run audit:bot`

**Step 3: Commit**
```bash
git add scripts/audit.ts
git commit -m "feat: add Market Regime section to audit #gemini"
```

---

### Task 3: Display Detailed Rejections & Intel

**Files:**
- Modify: `scripts/audit.ts`

**Step 1: Write minimal implementation**
```typescript
// Under News Cache and Action Logs, print out the last 5 `RISK_REJECTED` reasons.
// Read `~/.indic-bot/soul.md` and extract any recent `VERIFIED INTEL` or `EXTERNAL INSIGHTS` up to 5 lines.
```

**Step 2: Run script to verify it works**
Run: `npm run audit:bot`

**Step 3: Commit**
```bash
git add scripts/audit.ts
git commit -m "feat: enhance audit logs to show soul intel and rejections #gemini"
```
