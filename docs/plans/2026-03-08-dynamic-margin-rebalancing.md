# Dynamic Portfolio Allocation — Design Document

**Date:** 2026-03-08
**Status:** Draft v3 (after second review)

---

## 1. Problem Statement

### What happened (2026-03-08)

Bot has $188 balance. Three SHORT positions open:

| Pair | Entry | Margin | Lev | Unrealized PnL | Hours |
|------|-------|--------|-----|----------------|-------|
| SOL | $82.01 | $56.40 | 5x | -$0.72 (-1.3%) | ~6h |
| ETH | $1941.68 | $56.74 | 5x | -$2.16 (-3.8%) | ~6h |
| BNB | $618.37 | $55.55 | 5x | +$0.53 (+0.95%) | ~6h |

**Total margin locked:** $168.69 (89.7%)
**Available margin:** $16.96

Bot identified LINK SHORT 7 consecutive times (conf 72–77%, R:R 2.1–3.1x, BearTrend 4-5/5 confluence). Every attempt rejected: `margin needed $56.40 exceeds available ~$21`.

**Compounding problem:** `audit:db` showed 0 open positions when Binance had 3. Bot-state and exchange-state were desynchronized. This is the **most dangerous failure mode** — allocator making decisions on incorrect state.

### Two distinct problems

1. **State problem:** Bot doesn't have reliable canonical view of exchange state (positions, orders, margin)
2. **Allocation problem:** Bot can't reallocate capital once margin is locked

State problem must be solved first. An allocator making correct decisions on wrong data is worse than no allocator at all.

### 7 LINK rejections = 1 episode

Same pair, same side, same thesis, same regime. One setup episode seen 7 times. Wasted 7× LLM tokens. Need episode deduplication.

---

## 2. World Picture — Market Context (2026-03-08)

### Macro
- **Fear & Greed:** 12 (Extreme Fear)
- **Regime:** BearTrend (89%), earlier Capitulation (volume 2-3x)
- **Confluence:** 4-5/5 factors (trend, volume, VWAP, RSI, news)
- **Bot philosophy:** "Fear = fuel for SHORTs"

### News signals
- [9/10] BEARISH — Geopolitical escalation, oil surge, broad risk-off
- [8/10] BEARISH — Whales selling into retail, rapid profit-taking
- [7/10] BULLISH — Spot BTC ETF inflows (2nd straight week)
- [7/10] BEARISH — South Korea blocking firms from stablecoins
- Risk events: Middle East escalation, strong USD, private credit stress

---

## 3. Available Data

### Per open position (Binance + DB)
- `unrealizedPnlPct`, `unrealizedPnlUsd` — current P&L (Mark Price basis)
- `entryPrice`, `markPrice` — prices
- `leverage`, `initialMargin`, `maintMargin`, `notional`
- SL/TP prices + `workingType` — from open orders
- Entry confidence, `entry_thesis`, `invalidators[]` — from DB
- `totalPositionInitialMargin`, `totalOpenOrderInitialMargin`, `totalMaintMargin`, `availableBalance` — account-level fields

### Per new candidate (LLM decision)
- `confidence` (55–100), `stop_loss_pct`, `take_profit_pct`
- `setup_type`, `risk_flags[]`, `invalidators[]`
- `directional_bias`, `entry_valid_now`
- Regime, confluence factors

### Market context
- Regime + confidence, Fear & Greed, volume ratio
- News signals + sentiment, watchdog snapshots
- `lastFundingRate`, `nextFundingTime` — from mark price endpoint
- Funding history — `GET /fapi/v1/income` (FUNDING_FEE, COMMISSION)
- `GET /fapi/v1/fundingRate` — historical rates for forward estimate

---

## 4. Design Principles

### Principle 1: State correctness before allocation intelligence

If state confidence < threshold, allocator MUST NOT act. Worst case is not missing LINK — it's closing wrong position or thinking margin freed when it hasn't.

### Principle 2: One model, forward-looking

Don't compare backward PnL to forward confidence. For every position (open or candidate), ask the same question: **"What is the expected forward value of deploying this margin dollar here?"**

For open positions, this means: **"Would I open this position fresh right now at this price?"** (re-entry test). Not "how much has it made/lost since entry."

### Principle 3: Portfolio-marginal, not standalone

Don't ask "which position has lowest score?" Ask: **"Removing which position improves portfolio utility the most?"**

`evict_candidate_i = U(Portfolio) - U(Portfolio \ {i})`

A position can have decent standalone score but near-zero marginal diversification value.

### Principle 4: Continuous action space

Not binary open/close. Full action space:
- `open_full` — free margin sufficient
- `open_partial` — open smaller size than ideal
- `trim_and_open_partial` — reduce weakest, open partial new
- `trim_and_open_full` — reduce weakest enough for full new entry
- `swap_full` — close weakest entirely, open new
- `trim_only` — reduce overexposed position (risk management, no replacement)
- `skip` — current portfolio is optimal

### Principle 5: Net-of-all-costs

Every action evaluated after fees, slippage, funding delta, execution risk. "Slightly better" is never worth the friction on a small account.

### Principle 6: Single price basis

All scoring, risk calculations, and protective orders must use the **same price basis**. Either force `workingType: MARK_PRICE` on all SL/TP orders, or compute all utility on CONTRACT_PRICE. Mixing creates hidden basis risk inside the risk engine.

**Decision:** Use MARK_PRICE everywhere. Set `workingType: 'MARK_PRICE'` on all STOP_MARKET / TAKE_PROFIT_MARKET orders. Compute all distances, PnL, and proximity metrics from Mark Price.

---

## 5. Phase 0: Exchange State Reconciliation

### Why this is prerequisite

Allocator decisions are only as good as the state they're based on. Today's audit discrepancy (0 positions shown vs 3 real) proves the state layer is unreliable.

### Canonical State Assembly

Three data sources, layered:

```
┌─────────────────────────────────────────┐
│           Canonical State               │
│  (positions, orders, margin, balance)   │
├─────────────────────────────────────────┤
│ Layer 3: ORDER_TRADE_UPDATE (WebSocket) │ ← order fills, cancels
│ Layer 2: ACCOUNT_UPDATE (WebSocket)     │ ← balance/position changes
│ Layer 1: REST snapshot (periodic)       │ ← positionRisk + accountInfo
└─────────────────────────────────────────┘
```

**Layer 1 — REST polling (baseline):**
- `GET /fapi/v3/positionRisk` — all open positions with mark price
- `GET /fapi/v3/account` — full account info (margins, balances)
- `GET /fapi/v1/openOrders` — all protective orders (SL/TP)
- Poll at start of each cycle + after any execution

**Layer 2 — ACCOUNT_UPDATE (WebSocket):**
- Fires on: balance change, position change, margin type change
- Does NOT fire on: cancelled/unfilled orders alone
- In Cross: funding fee may arrive as balance-only update (no position payload)
- Updates canonical state in real-time between polls

**Layer 3 — ORDER_TRADE_UPDATE (WebSocket):**
- Fires on: order placed, filled, partially filled, cancelled, expired
- Essential for knowing when SL/TP actually triggered
- Required for order reconciliation after trims

### State Confidence Score

```typescript
interface StateConfidence {
  level: 'high' | 'medium' | 'low' | 'stale';
  lastRestSync: Date;
  lastWsUpdate: Date;
  positionCount: number;
  orderCount: number;
  reconciled: boolean;       // REST and WS agree
}
```

Rules:
- `high`: REST snapshot < 30s old AND WebSocket connected AND reconciled
- `medium`: REST snapshot < 2 min old, may have WS gaps
- `low`: REST snapshot > 2 min old OR WS disconnected
- `stale`: REST snapshot > 5 min old

**Hard gate:** Allocator can only execute swap/trim when `stateConfidence.level` is `high` or `medium`. At `low` or `stale`, allocator returns `skip` with reason `state_unreliable`.

### Order Reconciliation

After any trim/swap execution:
1. Wait for ORDER_TRADE_UPDATE confirming market order fill
2. Verify position size changed via positionRisk
3. Verify SL/TP orders still exist and reference correct position
4. If SL/TP missing or stale → re-place immediately
5. Log reconciliation result to DB

### Protective Order Policy

Standardize on one style for all protective orders:
- `STOP_MARKET` with `closePosition: true`, `workingType: 'MARK_PRICE'`
- `TAKE_PROFIT_MARKET` with `closePosition: true`, `workingType: 'MARK_PRICE'`
- No quantity field (closePosition handles it)
- After partial trim: `closePosition: true` automatically applies to remaining position size
- After full swap: cancel existing SL/TP before opening new position's orders

**Critical to verify on testnet:** that `closePosition: true` SL/TP correctly closes only the remaining position after a partial trim, not the original size.

---

## 6. Unified Scoring Model

### The re-entry value approach

Instead of two different models (retain_score vs entry_score), use **one model** applied to both:

```
For open position i:
  reentry_value(i) = entry_model(position_i_from_current_mark)
                   - exit_cost_if_replaced(i)
                   - capital_burden(i)
                   - marginal_correlation_penalty(i, portfolio)

For candidate j:
  candidate_value(j) = entry_model(candidate_j)
                     - entry_cost(j)
                     - marginal_correlation_penalty(j, portfolio)
```

Both use the **same** `entry_model()`. The difference is only in costs and portfolio context.

### entry_model() — shared evaluation

Scores any trade setup (real or hypothetical) from current market state:

```
entry_model(setup) = 100 × (
    calibrated_confidence × 0.25
  + remaining_rr_norm     × 0.25
  + confluence_norm        × 0.20
  + regime_fit             × 0.20
  + momentum_confirmation  × 0.10
)
```

| Component | Calculation | Range | Notes |
|-----------|-------------|-------|-------|
| calibrated_confidence | MVP: `(confidence - 55) / 45`. Later: DB-calibrated | 0..1 | Smooth shrinkage: pair×setup×regime → setup×regime → regime → global |
| remaining_rr_norm | `min(mark_to_tp / mark_to_sl, 4) / 4` | 0..1 | From **current Mark Price**, not entry. For candidates: from current price to proposed TP/SL |
| confluence_norm | `confluenceFactors.length / 5` | 0..1 | |
| regime_fit | SHORT in BearTrend=1.0, Range=0.6, BullTrend=0.1. Mirror for LONG | 0..1 | |
| momentum_confirmation | Price action in trade direction, ATR-normalized | 0..1 | Per-pair ATR normalization makes SOL and ETH comparable |

**For open positions:** "confidence" comes from re-evaluation: "If I saw this setup fresh right now, what would confidence be?" This can be:
- Original entry confidence (simple, but stale)
- Adjusted by invalidator status (better)
- Re-scored by lightweight LLM call (expensive but accurate, Phase 3)

### Cost adjustments

**For open position (cost of keeping):**
```
capital_burden(i) = (
    maintenance_margin_ratio(i)          // how much maint margin consumed
  + funding_rate_drag(i)                 // projected funding cost to next window
  + opportunity_cost(i)                  // margin locked × time × risk-free rate (negligible)
)
// Normalized to 0..20 range
```

**For open position (cost of eviction):**
```
exit_cost(i) = (
    close_fee                            // taker: notional × 0.04%
  + estimated_slippage                   // ~0.02%
  + realized_loss_if_negative            // unrealized PnL crystallized
)
// Normalized to 0..20 range
```

**For candidate (cost of entry):**
```
entry_cost(j) = (
    open_fee                             // taker: notional × 0.04%
  + estimated_slippage                   // ~0.02%
  + first_funding_window_cost            // if entering close to funding time
)
// Normalized to 0..20 range
```

### Correlation penalty — applied to both sides

Asset clusters:
- **BTC-core:** BTC
- **ETH-core:** ETH
- **Alt-L1:** SOL, AVAX, SUI, NEAR, APT
- **Alt-mid:** LINK, ADA, LTC
- **Meme:** DOGE, PEPE
- **Exchange:** BNB

```
marginal_corr_penalty(position, portfolio) =
    same_cluster_same_direction:  -15
    adjacent_cluster_same_dir:    -5
    different_cluster_or_opposite: 0
```

Applied symmetrically:
- When evaluating a **candidate**: penalty for being similar to existing portfolio
- When evaluating an **open position**: penalty if it's redundant with rest of portfolio (removing it costs little diversification)

For eviction, high correlation penalty means the position is **easier to evict** — removing it doesn't hurt portfolio diversity.

### Retain Score (diagnostic / explainability layer)

Keep `retain_score` as a human-readable diagnostic, not as the primary comparator:

```
retain_score = 100 × (
    thesis_fit       × 0.30    // invalidator engine result
  + remaining_rr     × 0.25    // mark-to-TP / mark-to-SL
  + momentum         × 0.20    // ATR-normalized
  + tp_progress      × 0.15    // path completion
  + vitality         × 0.10    // inverse of stagnation
)
```

This is logged for observability but **not used for swap decisions**. Swap decisions use the unified `reentry_value` vs `candidate_value` comparison.

---

## 7. Structured Invalidators

### Machine-checkable format

LLM generates invalidators from a **whitelist schema** only:

```typescript
interface StructuredInvalidator {
  metric: 'price_vs_vwap' | 'rsi_1h' | 'rsi_4h' | 'regime' | 'volume_ratio'
        | 'oi_change_pct' | 'funding_rate' | 'price_level' | 'macd_histogram';
  op: '>' | '<' | '>=' | '<=' | '==' | 'in' | 'not_in';
  threshold: number | string | string[];
  window?: '1h' | '4h' | '1d';
  severity: 'hard' | 'soft';      // hard = instant eviction eligible, soft = degrades thesis_fit
}
```

Unknown metrics → rejected/ignored. This prevents beautiful but uncheckable invalidators.

### Evaluation

Each cycle, for each open position:
```
invalidator_results = position.invalidators.map(inv => check(inv, currentMarketData))

hard_hits = results.filter(r => r.hit && r.severity === 'hard')
soft_hits = results.filter(r => r.hit && r.severity === 'soft')

if (hard_hits.length > 0) → thesis_fit = 0.0 (force evictable)
else thesis_fit = 1.0 - (soft_hits.length * 0.2)  // degrades with each soft hit
```

### Price precision

All price comparisons must account for Binance tick size / price precision. "Within 20% of SL" must use truncated/rounded prices matching exchange precision, not raw floats.

---

## 8. Decision Logic

### Layer 1: Hard Risk Exits (no comparison needed)

Force-close without comparing to candidates:
- Hard invalidator triggered (§7)
- Regime materially reversed for 2+ consecutive cycles
- Maintenance margin warning from exchange
- Session/daily loss limit hit
- Position held > maxHoldHours

### Layer 2: Allocation Optimization

Triggered when RiskManager returns `MARGIN_SHORTFALL`:

```typescript
interface MarginShortfall {
  type: 'MARGIN_SHORTFALL';
  pair: string;
  neededMargin: number;
  availableMargin: number;
  shortfall: number;
  candidate: TradeDecision;
}

function evaluateRebalancing(
  shortfall: MarginShortfall,
  portfolio: PortfolioState,
  marketContext: MarketContext,
  stateConfidence: StateConfidence
): RebalanceAction {

  // Hard gate: state must be reliable
  if (stateConfidence.level === 'low' || stateConfidence.level === 'stale') {
    return { action: 'skip', reason: 'state_unreliable' };
  }

  // Rate limit: max 2 rebalancing actions per hour
  if (rebalanceCountLastHour >= 2) {
    return { action: 'skip', reason: 'rate_limited' };
  }

  const candidateValue = computeCandidateValue(shortfall.candidate, portfolio, marketContext);

  // Evaluate each open position's marginal contribution
  const evictionCandidates = portfolio.positions
    .filter(p => p.heldHours >= 0.5)                    // min hold 30 min
    .filter(p => computeTpProgress(p) < 0.8)            // don't evict near-TP
    .filter(p => p.pair !== shortfall.candidate.pair)    // don't evict same pair
    .map(p => ({
      position: p,
      reentryValue: computeReentryValue(p, portfolio, marketContext),
      marginalPortfolioValue: computeMarginalValue(p, portfolio),
      releasableMargin: p.marginUsd,
    }))
    .sort((a, b) => a.marginalPortfolioValue - b.marginalPortfolioValue);

  for (const ec of evictionCandidates) {
    // Can we partially trim instead of full swap?
    const canTrim = ec.releasableMargin > shortfall.shortfall * 1.5;
    const trimPct = canTrim ? shortfall.shortfall / ec.releasableMargin : 1.0;

    // Can candidate open at partial size?
    const canOpenPartial = shortfall.shortfall > ec.releasableMargin * 0.3;

    // Compute swap cost
    const swapCost = estimateSwapCost(ec.position, shortfall.candidate, trimPct);

    // Net delta: is this swap worth it?
    const delta = candidateValue - ec.reentryValue - swapCost;

    if (delta < MIN_DELTA) continue;

    if (canTrim) {
      return {
        action: 'trim_and_open',
        evictPair: ec.position.pair,
        trimPct,
        candidate: shortfall.candidate,
        candidateSize: 'full',
        delta,
        swapCost,
      };
    }

    if (ec.releasableMargin >= shortfall.neededMargin) {
      return {
        action: 'swap_full',
        evictPair: ec.position.pair,
        candidate: shortfall.candidate,
        delta,
        swapCost,
      };
    }

    // Partial: close weakest fully but open candidate at reduced size
    if (canOpenPartial) {
      const achievableSize = ec.releasableMargin / shortfall.neededMargin;
      return {
        action: 'swap_and_open_partial',
        evictPair: ec.position.pair,
        candidate: shortfall.candidate,
        candidateSizePct: achievableSize,
        delta,
        swapCost,
      };
    }
  }

  return { action: 'skip', reason: 'no_profitable_swap' };
}
```

### Swap Cost Calculation

```
swap_cost = (
    close_taker_fee                   // notional × 0.04%
  + open_taker_fee                    // new_notional × 0.04%
  + estimated_slippage × 2            // ~0.02% per side
  + funding_delta                     // net funding rate change
  + churn_base_penalty(3 points)      // discourage rotation
  + uncertainty_band(2 points)        // uncalibrated confidence buffer
)
// All normalized to same 0-100 scale as scores
```

### MIN_DELTA

Dynamic, not fixed:
```
MIN_DELTA = base(5) + swap_cost + market_noise_buffer
```

`market_noise_buffer` increases in low-volume / high-spread conditions.

---

## 9. Opportunity Cache (Episode Deduplication)

### Fingerprint

```typescript
interface CandidateEpisode {
  pair: string;
  side: 'LONG' | 'SHORT';
  setupType: string;
  regime: string;
  thesisHash: string;
  // Additional dimensions:
  volatilityBucket: 'low' | 'normal' | 'high';
  atrDisplacement: number;           // ATR distance from firstSeen price
  fundingSign: 'positive' | 'negative' | 'neutral';
  btcLeadRegime: string;             // BTC's regime at time of signal
  // Lifecycle:
  firstSeen: Date;
  lastEvaluated: Date;
  entryScore: number;
  priceAtFirstSeen: number;
  ttlMinutes: number;
  invalidated: boolean;
}
```

### Rules
- Same fingerprint within TTL → reuse cached score, don't re-analyze
- Re-evaluate when: portfolio changes, price moves > 1 ATR, regime shifts, news changes
- When margin becomes available → immediately check cached candidates (sorted by entry_score)
- Episode expires on: TTL, price > 1.5 ATR displacement, regime change, invalidator hit
- TTL: 60 min (trend_continuation), 30 min (scalping), 120 min (macro)

---

## 10. Portfolio-Level Constraints

### Portfolio Heat (Cross Margin)

In Cross margin, one weak position taxes the entire book. Monitor:
- `totalMaintMargin / totalWalletBalance` — maintenance margin ratio
- `availableBalance / totalWalletBalance` — free capital ratio
- Per-position capital burden: `initialMargin(i) / totalWalletBalance`

Eviction should consider not just "weakest trade" but "which removal reduces portfolio heat the most":

```
marginal_keep_value(i) =
    reentry_value(i)
  - capital_burden(i)
  - tail_risk_burden(i)          // distance to liquidation contribution
  - concentration_penalty(i)     // cluster overlap with rest of portfolio
```

### Directional Exposure Cap

Based on risk-at-stop, not margin:
```
risk_at_stop(i) = margin(i) × stop_loss_pct(i) × leverage(i)
portfolio_risk = Σ risk_at_stop(i) for all same-direction positions
max_risk = balance × max_risk_budget_pct
```

### Free Margin Reserve

Hard config: `minFreeMarginPct: 15` (default 15%)
- Allocator cannot use margin that would bring free margin below reserve
- Prevents 90%+ utilization traps
- $188 → reserve $28. $1800 → reserve $270.

---

## 11. Partial Trim Mechanics (Binance Futures)

### Execution sequence

1. Verify state confidence is `high` or `medium`
2. Place MARKET order with `reduceOnly: true` for trim quantity
3. Wait for ORDER_TRADE_UPDATE confirming fill
4. Verify position size via positionRisk REST call
5. Existing SL/TP with `closePosition: true` should auto-apply to remaining size
6. If SL/TP levels need changing → cancel and re-place
7. Log reconciliation

### Key Binance constraints
- `closePosition: true` orders cannot have quantity, cannot combine with `reduceOnly`
- `closePosition: true` closes "all current long or short position" at trigger time
- After trim, "all current position" = remaining size (to verify on testnet)
- Reduce-only orders may be rejected if they conflict with existing open orders (-2022, -4118)
- Modify-order endpoints require quantity and don't work with `closePosition: true`

### Standardized order style
- All SL/TP: `closePosition: true`, `workingType: 'MARK_PRICE'`
- Trims: `reduceOnly: true` MARKET orders with explicit quantity
- Never mix `closePosition` and quantity-based `reduceOnly` on same position
- After any trim: verify SL/TP still valid, re-place if trigger levels changed

### Must verify on testnet before production
- `closePosition: true` behavior after partial position reduction
- Order conflict errors with existing protective orders
- Margin release timing after partial close

---

## 12. Confidence Calibration Roadmap

### Problem
Raw LLM confidence (77%) is not a probability. Without calibration, it's a ranking signal at best.

### Hierarchical Bayesian approach (smooth shrinkage)

Not a hard switch at 100 trades. Instead, use progressively specific priors:

```
Level 0: global_prior           (all trades)
Level 1: regime_prior           (BearTrend, Range, etc.)
Level 2: setup×regime_prior     (trend_continuation × BearTrend)
Level 3: pair×setup×regime      (LINK × trend_continuation × BearTrend)
```

When a bucket has few samples, it pulls toward the more general prior. As samples accumulate, the specific bucket dominates.

### What to track per bucket
- Hit rate (TP hit before SL)
- Average win size (% of TP reached when winning)
- Average loss size (% of SL reached when losing)
- Expected value: `hit_rate × avg_win - (1 - hit_rate) × avg_loss`
- Sample count

### Data source
- `trade_decisions` + `trade_closes` tables
- Need: confidence_bucket, setup_type, regime, pair, outcome (win/loss), realized PnL

### Phase-in
- MVP: use raw confidence with weight 0.25 (reduced trust)
- 50+ trades: enable Level 0+1 calibration
- 200+ trades: enable Level 2
- 500+ trades: enable Level 3

---

## 13. Codebase Changes

### Phase 0: State Reconciliation

**New: `src/binance/state-reconciler.ts`**
- `ExchangeState` canonical model (positions, orders, margins, balances)
- REST snapshot polling
- ACCOUNT_UPDATE + ORDER_TRADE_UPDATE handling
- `StateConfidence` computation
- Reconciliation checks (REST vs WS agreement)

**Modified: `src/binance/client.ts`**
- Expose `positionRisk` and `openOrders` queries
- Add `workingType: 'MARK_PRICE'` to all protective order placements

**Modified: `src/binance/orders.ts`**
- Standardize all SL/TP to `workingType: 'MARK_PRICE'`
- Add partial trim method: `trimPosition(pair, trimPct)`
- Post-execution order reconciliation

### Phase 1: Core Allocator

**New: `src/risk/portfolio-allocator.ts`**
- `computeEntryModel(setup, marketData)` — shared evaluation
- `computeReentryValue(position, portfolio, marketData)` — for open positions
- `computeCandidateValue(candidate, portfolio, marketData)` — for new trades
- `computeMarginalValue(position, portfolio)` — portfolio contribution
- `evaluateRebalancing(shortfall, portfolio, marketContext, stateConfidence)` → RebalanceAction
- `estimateSwapCost(closePosition, openCandidate, trimPct)` → number

**New: `src/risk/invalidator-engine.ts`**
- `StructuredInvalidator` type with whitelist schema
- `checkInvalidators(position, marketData)` → results
- `computeThesisFit(invalidatorResults)` → 0..1

**New: `src/risk/opportunity-cache.ts`**
- `CandidateEpisode` storage with enriched fingerprint
- TTL management, ATR-displacement invalidation
- `getCachedCandidates()` sorted by entry_score

**Modified: `src/risk/manager.ts`**
- Return structured `MarginShortfall` rejection type
- Include `shortfall`, `neededMargin`, `candidate` in rejection

**Modified: `src/trading-loop.ts`**
- After `MARGIN_SHORTFALL` → call allocator
- Check opportunity cache before full LLM analysis
- Execute trim/swap actions with order reconciliation

**New DB table: `portfolio_rebalancing_events`**
- cycle_id, action_type, evicted_pair, evicted_reentry_value, new_pair, new_candidate_value, delta, swap_cost, trim_pct, outcome

**Modified DB: `trade_executions`**
- Add `structured_invalidators` JSONB column

**New config in `config.yaml`:**
```yaml
allocation:
  enabled: false                    # feature flag
  minFreeMarginPct: 15              # hard reserve
  maxRebalancesPerHour: 2
  minHoldBeforeEvictMinutes: 30
  tpProgressLockThreshold: 0.8      # don't evict above this
  minDelta: 5                       # base swap threshold
  churnPenalty: 3
  uncertaintyBand: 2
```

### Phase 2: Enhanced
- Partial trim execution + testnet verification
- Confidence calibration pipeline
- Event-driven reevaluation (WebSocket-triggered)

### Phase 3: Advanced
- Risk-at-stop position sizing
- Full portfolio utility optimization
- Cross/Isolated margin mode-aware policies
- Re-scoring open positions via lightweight LLM call

---

## 14. Scaling to $1800

### Config changes
```yaml
trading:
  minPositionPct: 10
  maxPositionPct: 25
  maxLossUsd: 150

allocation:
  enabled: true
  minFreeMarginPct: 15
```

### Effect
- 10% × $1800 = $180 per position → 7-8 simultaneous positions
- Free margin reserve: $270 always available
- Allocator rotates weakest positions for better opportunities
- Correlation penalty prevents all-alt-short concentration
- Partial trims allow fine-grained capital redistribution

### With risk-at-stop sizing (Phase 3)
```
risk_usd = $1800 × 2% = $36 per trade
notional = $36 / 2% SL = $1800
margin = $1800 / 10x = $180
```
Tight stop → bigger position. Wide stop → smaller position. Portfolio auto-adapts.

---

## 15. Open Questions (Updated)

1. **Testnet verification:** Does `closePosition: true` on SL/TP correctly close remaining position after partial trim? Must test before production.
2. **Cross margin shared PnL:** In Cross, unrealized loss on one position reduces available margin for all. Does eviction logic need to account for "freeing" both margin AND unrealized loss?
3. **LLM invalidator generation:** Can prompting with whitelist schema reliably produce machine-checkable JSON? Need to test prompt engineering approach vs deterministic mapping.
4. **WebSocket reliability:** Bot currently uses REST polling. Adding WS for ACCOUNT_UPDATE/ORDER_TRADE_UPDATE requires connection management, reconnection logic. Worth it for Phase 0 or defer to Phase 2?
5. **Funding measurement:** Need historical funding data from `GET /fapi/v1/income` to calibrate funding drag estimates. How much does it actually cost on 5x alt shorts in extreme fear?
