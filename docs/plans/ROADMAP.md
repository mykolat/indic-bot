# Indic Bot — Roadmap (Prioritized)

> Based on quant review analysis (`docs/knowledge/quant-review-2026-03.md`)
> Last updated: 2026-03-07

---

## P0 — Blowup Prevention (do before scaling)

| # | Issue | Title | Effort | Impact |
|---|---|---|---|---|
| 1 | [#22](https://github.com/mykolat/indic-bot/issues/22) | Beta-adjusted exposure — correlated liquidation protection | Medium | **CRITICAL** |
| 2 | [#28](https://github.com/mykolat/indic-bot/issues/28) | Liquidation stream (Binance WS forceOrder) | Medium | **CRITICAL** |

## P1 — Reduce Friction Losses

| # | Issue | Title | Effort | Impact |
|---|---|---|---|---|
| 3 | [#23](https://github.com/mykolat/indic-bot/issues/23) | Regime persistence — hysteresis (3-cycle stable) | Low | HIGH |
| 4 | [#24](https://github.com/mykolat/indic-bot/issues/24) | Weekend leverage reduction (Sat/Sun 0.5x) | Trivial | MEDIUM |

## P2 — Use Data We Already Collect

| # | Issue | Title | Effort | Impact |
|---|---|---|---|---|
| 5 | [#25](https://github.com/mykolat/indic-bot/issues/25) | Funding rate as explicit signal/filter | Low | MEDIUM |
| 6 | [#26](https://github.com/mykolat/indic-bot/issues/26) | OI divergence detection (squeeze/trend) | Low | MEDIUM |
| 7 | [#30](https://github.com/mykolat/indic-bot/issues/30) | Surface imbalancePct (OBI) in watchdog summary | Low | MEDIUM |

## P3 — Prove Edge

| # | Issue | Title | Effort | Impact |
|---|---|---|---|---|
| 8 | [#29](https://github.com/mykolat/indic-bot/issues/29) | Dashboard quant metrics (Sharpe, drawdown, profit factor) | Medium | HIGH (at 100+ trades) |

## P4 — At Scale ($10K+)

| # | Issue | Title | Effort | Impact |
|---|---|---|---|---|
| 9 | [#31](https://github.com/mykolat/indic-bot/issues/31) | Limit order entry — reduce slippage | Medium | LOW now, HIGH at $10K |
| 10 | [#27](https://github.com/mykolat/indic-bot/issues/27) | Order Book Imbalance as standalone signal | Medium | MEDIUM |

## Backlog — Future ($100K+)

| # | Title | Notes |
|---|---|---|
| 11 | Strategy library (trend/range/reversal/funding) | Multi-strategy selection by regime |
| 12 | Coinglass API ($30/mo) — aggregated liquidation heatmap | Cross-exchange liquidation data |
| 13 | TWAP/VWAP execution engine | Minimize market impact |
| 14 | Full portfolio risk model (covariance matrix) | Factor-based risk |
| 15 | CVD (Cumulative Volume Delta) | Tick-level orderflow |

## Already Implemented (ChatGPT thought missing)

| Feature | Where | Since |
|---|---|---|
| OBI (order book imbalance) collection | `market-data.ts` → `imbalancePct` | v1.x |
| Funding rate collection | `market-data.ts` → `fundingRate` | v1.x |
| Open Interest + spike detection | `watchdog.ts` → OI anomaly | v1.x |
| Long/Short ratio | `market-data.ts` → `longShortRatio` | v1.x |
| Volatility position sizing (VT cap) | `trading-loop.ts:862` | v2.0 |
| LLM → Risk → Execution architecture | `RiskManager.validate()` gates all trades | v1.x |
| Dual-loop (Watchdog 1min + Brain 10min) | `watchdog.ts` + `trading-loop.ts` | v2.0 |
| SL/TP on exchange (protected 24/7) | `orders.ts` → STOP_MARKET + TP_MARKET | v1.x |
| Flash crash guard | `flash-crash.ts` → Grok sentiment | v2.0 |
| Circuit breaker with half-open state | `circuit-breaker.ts` | v2.0 |

---

## Open Issues Summary

| Priority | Count | Issues |
|---|---|---|
| P0 | 2 | #22, #28 |
| P1 | 2 | #23, #24 |
| P2 | 3 | #25, #26, #30 |
| P3 | 1 | #29 |
| P4 | 2 | #27, #31 |
| EPIC | 1 | #21 |
| **Total** | **11** | |
