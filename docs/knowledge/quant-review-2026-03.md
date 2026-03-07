# Quant Review — External Audit + Internal Analysis

> **Source:** ChatGPT quant review session (March 2026)
> **Internal review by:** Claude (against actual codebase)
> **Purpose:** Knowledge base for architectural decisions and future roadmap

---

## 1. What We Got Right (Confirmed by External Review)

### Regime Detection — industry standard
- EMA20/EMA50 alignment, ADX > 25, VWAP, BB bandwidth, ATR spike
- Used by CTA funds, crypto quant desks, prop firms
- Our 6 regimes (BullTrend, BearTrend, Range, Breakout, Capitulation, Scalping) cover the main market states

### Risk Validation — "most LLM bots die here"
- Confidence >= 55%, SL required, max exposure caps
- RiskManager as gatekeeper between LLM proposals and execution
- This is the correct architecture: `signals -> model -> risk engine -> execution`

### Multi-Timeframe Indicators
- 1h + 4h RSI, EMA, ADX, VWAP, BB, MACD
- Classic systematic trading structure

### Circuit Breakers — professional practice
- Max session loss ($30 / 10%)
- Stale position exit (8h with <1% PnL)
- Flash crash guard (Grok-powered sentiment scan)
- Circuit breaker with half-open recovery state

### Dual-Loop Architecture — not recognized by reviewer
The external review missed this entirely. Watchdog (1-min algorithmic) + Brain (10-min LLM) means:
- Bot is NOT blind between Brain cycles
- SL/TP on Binance protect positions 24/7
- Anomaly detection runs every 60 seconds

---

## 2. Valid Concerns — Prioritized for Implementation

### P0: Correlated Liquidation Risk
**Problem:** BTC, ETH, SOL, ADA etc have correlation 0.7-0.9. Max exposure 150% means effective BTC-equivalent risk can be ~220-300%.

**Solution:** Beta-adjusted exposure calculation.
```
effective_exposure = sum(position_size * beta_to_BTC)
```
Approximate betas: ETH ~1.3, SOL ~1.8, DOGE ~2.0, ADA ~1.5

**When critical:** When running 3+ simultaneous positions. Even at $185 balance, a correlated crash across 3 alts at 150% exposure could hit max loss quickly.

**Scaling note:** This becomes the #1 survival factor as balance grows past $1K.

### P1: Regime Persistence / Hysteresis
**Problem:** Regime recalculated every cycle. Market can flip BullTrend -> Range -> BullTrend in 30 minutes, causing strategy churn (fees + slippage without edge).

**Current mitigation:** Churn cooldown (15 min) partially addresses this.

**Solution:** Require regime to be stable for N cycles (3-5) before switching strategy. Or require ADX change > threshold.

**Scaling note:** More critical as trade frequency increases.

### P2: Weekend Liquidity Reduction
**Problem:** Crypto volume drops 40-60% on weekends. Breakout signals more likely false. Liquidity thinner = worse fills.

**Solution:** Reduce leverage multiplier on Sat/Sun (e.g., 0.5x normal). Trivial to implement.

**Scaling note:** Always relevant regardless of balance size.

### P3: Funding Rate as Signal
**Problem:** We collect funding rate data in Watchdog but don't use it as a signal.

**Signal logic:**
- Funding > 0.05% = overcrowded longs, reversal risk
- Funding < -0.05% = overcrowded shorts, squeeze risk
- Combine with volume spike for stronger signal

**Current state:** Data already in `market_snapshots` table. Needs signal extraction.

**Scaling note:** Becomes more useful as we trade more pairs.

### P4: Open Interest Divergence
**Problem:** OI data collected but not analyzed for divergence patterns.

**Signal logic:**
- Price up + OI up = new positions (trend continuation)
- Price up + OI down = short squeeze (potential reversal)
- Price down + OI up = new shorts (bearish)
- Price down + OI down = long liquidation (potential bottom)

**Current state:** Data already in `market_snapshots` table.

### P5: Order Book Imbalance (OBI)
**Problem:** Watchdog collects order book spread but doesn't compute bid/ask volume imbalance.

**Signal:** `OBI = bid_volume / ask_volume`. OBI > 1.5 = upward pressure, OBI < 0.7 = downward pressure.

**Implementation:** Needs depth data from Binance API (top 5-10 levels).

**Scaling note:** More useful at higher trade frequency.

---

## 3. Future Architecture — When Balance Grows

### Strategy Library (Balance > $1K)
Instead of one LLM-driven strategy, maintain multiple deterministic strategies:

| Strategy | Regime | Entry Logic |
|---|---|---|
| Trend Following | BullTrend/BearTrend | EMA cross + momentum + volume |
| Mean Reversion | Range | BB bounce + VWAP reversion |
| Breakout | Breakout | Volume spike + ATR + BB expansion |
| Liquidation Reversal | Capitulation | Liquidation spike + volume + reversal candle |
| Funding Arbitrage | Any | Extreme funding + contrarian |

LLM role shifts from "decide LONG/SHORT" to "select strategy + set bias + assess risk".

### Execution Engine (Balance > $5K)
At larger sizes, MARKET orders create measurable slippage.

**Evolution path:**
1. Current ($185): MARKET orders fine, slippage < $0.01
2. $1K-5K: Add limit order with market fallback
3. $5K+: Limit ladder (30/40/30 split)
4. $10K+: TWAP/VWAP execution

### Portfolio Risk Model (Balance > $2K)
Full factor risk model:

```
portfolio_risk = sqrt(sum(w_i * w_j * cov_ij))
```

Simplified version first: beta-adjusted exposure (P0 above).

### Liquidation Feed (Balance > $1K)
External data source (Coinglass / Hyblock / Binance WebSocket).

**Signals:**
- Liquidation clusters near price = magnet
- Liquidation spike = potential reversal
- Long/short ratio extremes

**Cost:** Coinglass API ~$30/month. Worth it when trading is profitable.

### CVD — Cumulative Volume Delta (Balance > $5K)
Requires tick-level data stream. Shows aggressive buyers vs sellers independently of price.

**Signal:** Price flat + CVD rising = hidden accumulation (bullish).

---

## 4. What External Review Got Wrong

### "LLM shouldn't make final decisions"
**Reality:** Our RiskManager IS the gatekeeper. LLM proposes, Risk validates/rejects. This is already the `signals -> model -> risk -> execution` architecture they recommend.

### "10-min cycle = bot is blind"
**Reality:** Watchdog runs every 60 seconds. SL/TP on Binance exchange. FlashCrash guard at cycle start. Circuit breaker with half-open state.

### "Graph RAG doesn't work due to non-stationary markets"
**Reality:** Our episodic search includes regime context in the query string. Similar episodes are found within market context, not randomly.

### "News engine is useless"
**Reality:** We use news for regime awareness (exactly what they recommend), not for entry timing. News -> MacroAnalyst -> regime bias, not news -> trade.

### "Stale exit kills trends"
**Reality:** Stale exit requires <1% PnL. If trend continues, PnL > 1% and stale exit doesn't trigger.

### "Scalping guaranteed to lose"
**Reality:** Math is off. 0.08% round-trip fee on 1% TP = 8% of profit, not edge destruction. With minConfidence 72 and leverageMultiplier 0.1, we're extremely selective.

---

## 5. Signals Reference — Crypto Quant Toolkit

### Currently Implemented
- [x] EMA cross (20/50)
- [x] ADX trend strength
- [x] RSI momentum
- [x] VWAP distance
- [x] Bollinger Bands (%B, bandwidth)
- [x] MACD + histogram
- [x] Volume ratio (vs 20-period avg)
- [x] ATR (absolute + spike detection)
- [x] Fear & Greed index
- [x] News sentiment (CryptoPanic + RSS)
- [x] Macro indicators (DXY, VIX, S&P500, Gold, WTI)

### Data Collected But Not Used as Signals
- [ ] Funding rate (in market_snapshots)
- [ ] Open interest (in market_snapshots)
- [ ] Order book spread (in market_snapshots)
- [ ] Price velocity (calculable from snapshots)

### Not Yet Collected
- [ ] Order book depth / imbalance (OBI)
- [ ] CVD (Cumulative Volume Delta)
- [ ] Liquidation data
- [ ] EMA slope (calculable from existing EMA)
- [ ] Realized volatility (vs implied)

### Signals That Look Smart But Don't Work Well in Crypto (per quant consensus)
- RSI divergence alone (too many false signals in trending crypto)
- MACD crossover alone (lagging, by the time it crosses the move is done)
- Simple moving average systems (EMA is strictly better)
- Fibonacci levels (self-fulfilling only at round numbers)
- Elliott Wave (subjective, not programmable)

---

## 6. Key Architectural Principle

> The goal is not to predict the market. The goal is to **survive every regime**.

Current architecture handles this through:
1. Regime detection -> adaptive FilterProfiles
2. Risk validation -> prevents overexposure
3. Circuit breakers -> survive black swans
4. Memory system -> learn from past mistakes

Future architecture adds:
5. Strategy library -> right tool for right regime
6. Beta-adjusted exposure -> survive correlated crashes
7. Execution engine -> minimize friction as size grows

---

## 7. Metrics We Should Track (Missing from Dashboard)

| Metric | Formula | Why |
|---|---|---|
| Sharpe Ratio | mean(returns) / std(returns) * sqrt(365) | Risk-adjusted return |
| Max Drawdown | max peak-to-trough decline | Worst case scenario |
| Profit Factor | gross_profit / gross_loss | Edge measurement |
| Average R | avg(PnL / risk_per_trade) | Risk-adjusted per trade |
| Win Rate | wins / total | Only meaningful with 100+ trades |
| Expectancy | (winRate * avgWin) - (lossRate * avgLoss) | Expected $ per trade |
| Calmar Ratio | annualized_return / max_drawdown | Return per unit of pain |

**Minimum for statistical significance:** 500+ trades or 6+ months of data.

---

## 8. ChatGPT Round 2 — Follow-up Analysis

### What ChatGPT confirmed as correct in our analysis
- Beta-adjusted exposure as #1 priority
- Regime persistence as cheap high-impact improvement
- Weekend leverage reduction as trivial win
- Our LLM latency defense (Watchdog + SL/TP on exchange)
- Our scalping math correction (8% of profit, not edge destruction)
- Our dual-loop architecture as significantly stronger than typical bots

### What ChatGPT suggested that we ALREADY have
- **Volatility-scaled position sizing** — already implemented as VT (Volatility Targeting) cap in `trading-loop.ts:862-873`. Calculates `maxVtSize = (balance * targetRiskPct%) / slDistancePct%`. ChatGPT doesn't know this exists.
- **LLM as regime classifier, not entry decider** — already our architecture (LLM proposes, RiskManager gates)

### New valid point: Graph RAG regime filtering
Even within same regime, 2023 Range != 2025 Range due to market structure drift (ETF flows, regulatory changes). RAG should be treated as context, not signal. **Worth monitoring but not urgent.**

### Liquidation data — upgraded to P0
User decision: Binance WebSocket `forceOrder` stream is free and we trade on Binance only.
This should be integrated into Watchdog NOW, not deferred.

**Architecture:**
```
Binance WS forceOrder stream
  → Watchdog aggregates per pair per minute
  → Stores in liquidations table or market_snapshots
  → Brain reads liquidation summary (spike detection)
  → LLM sees: "BTCUSDT: 47 long liquidations ($2.3M) in last 10min"
```

**Signals:**
- Liquidation spike > 5x rolling avg = potential reversal
- Long liq cluster = bearish pressure / potential bottom
- Short liq cluster = bullish pressure / potential squeeze

### Roadmap alignment (agreed by external review)

| Phase | Items | Trigger |
|---|---|---|
| Phase 1 (NOW) | Beta exposure, regime persistence, liquidation WS | Before scaling |
| Phase 2 (profitable) | OBI, funding filter, weekend mode | After 50+ trades |
| Phase 3 ($10K+) | Liquidation heatmap (Coinglass), quant metrics | Proven edge |
| Phase 4 ($100K+) | Strategy library, execution engine, portfolio optimizer | Fund-grade |

---

*Last updated: 2026-03-07*
