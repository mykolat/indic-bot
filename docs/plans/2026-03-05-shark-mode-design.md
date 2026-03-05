# Shark Mode — Regime-Adaptive Trading with LLM Override

**Date**: 2026-03-05
**Status**: Approved
**Branch**: TBD

## Problem

Bot is a "cold analyst" — 98.8% HOLD rate (646/654 decisions). Root causes:
- RSI entry range 40-65 blocks entries in bull trends (RSI 70-90)
- Volume threshold 1.0x blocks entries during off-hours (0.3-0.5x)
- Confluence 3/5 requirement fails when RSI + volume both fail
- "Be selective / This is LIVE money" prompt makes LLM overly passive
- Single strategy for all market conditions

## Solution

5 market regimes, each with adaptive filter profiles. Hybrid classification: rule-based classifier + LLM override. Decision journal + trade stories for context continuity.

## Architecture

### 1. Market Regime Classifier (`src/market/regime-classifier.ts`)

Rule-based classifier using 4h indicators:

| Regime | Detection Rules |
|--------|----------------|
| **Bull Trend** | EMA20 > EMA50 (4h) + ADX > 25 + price > VWAP |
| **Bear Trend** | EMA20 < EMA50 (4h) + ADX > 25 + price < VWAP |
| **Range** | ADX < 20 + Bollinger bandwidth < 4% |
| **Breakout** | Volume > 1.5x + ATR > 1.5x avg + price outside Bollinger Bands |
| **Capitulation** | F&G < 15 OR 4h drop > 5% OR volume > 3x avg |

Output: `{ regime: MarketRegime, confidence: number (0-100), factors: string[] }`

Priority: Capitulation > Breakout > Bull/Bear Trend > Range (if multiple match).

### 2. Adaptive Filter Profiles (`src/market/filter-profiles.ts`)

Each regime has its own entry filter set, replacing the current hardcoded rules:

| Parameter | Bull Trend | Bear Trend | Range | Breakout | Capitulation |
|-----------|-----------|-----------|-------|----------|-------------|
| RSI entry | 45-80 | 20-55 | 30-70 | any | any |
| Volume min | 0.6x | 0.6x | 0.5x | 1.2x | 0.8x |
| Confluence min | 2/5 | 2/5 | 2/5 | 3/5 | 1/5 |
| Max leverage | config | config | config/2 | config | config/4 |
| SL style | trailing % | tight fixed | range bounds | wide ATR-based | tight fixed |
| TP style | trailing | fixed | range bounds | momentum | DCA/scale-out |
| Min confidence | 50 | 55 | 50 | 60 | 45 |

Profiles are config objects, not hardcoded in the prompt.

### 3. LLM Override Mechanism

LLM receives in the prompt:
- Current regime + confidence from classifier
- Active filter profile for this regime
- Instruction: "You MAY override the regime if evidence contradicts the classifier. Provide `regime_override` + `override_reason`."

Extended response format:
```json
{
  "regime_override": "breakout",
  "override_reason": "Volume spike on 15m not reflected in 4h yet",
  "decisions": [...]
}
```

Override is logged in decision journal. Risk manager still validates all trades regardless of override.

### 4. Decision Journal (`logs/decision-journal.jsonl`)

Every cycle logs full decision context per pair:
```json
{
  "timestamp": "2026-03-05T12:00:00Z",
  "pair": "BTCUSDT",
  "regime": "bull_trend",
  "regime_confidence": 82,
  "regime_override": null,
  "filters_applied": {
    "rsi": {"value": 72, "range": [45, 80], "passed": true},
    "volume": {"value": 0.65, "min": 0.6, "passed": true},
    "confluence": {"score": 3, "min": 2, "passed": true},
    "fear_greed": {"value": 35, "leverage_cap": null}
  },
  "action": "LONG",
  "reasoning": "...",
  "confidence": 75,
  "risk_validation": "PASSED",
  "indicators_snapshot": {
    "rsi_1h": 72, "rsi_4h": 65,
    "ema20_1h": 71500, "ema50_1h": 71200,
    "volume_ratio": 0.65, "atr_4h": 1200,
    "funding_rate": 0.005, "vwap": 71300
  }
}
```

### 5. Trade Stories (`logs/trade-stories.jsonl`)

On every CLOSE, LLM writes a trade story. Injected into next prompts (last 5 stories) to prevent premature exits and provide context continuity.

```json
{
  "pair": "BTCUSDT",
  "direction": "LONG",
  "entry_time": "2026-03-05T10:00:00Z",
  "exit_time": "2026-03-05T14:30:00Z",
  "entry_price": 72000,
  "exit_price": 73500,
  "pnl_pct": 2.1,
  "regime_at_entry": "bull_trend",
  "regime_at_exit": "range",
  "story": "Entered on bull trend pullback to VWAP with volume confirmation. Held through range transition. Closed on TP hit after 4h consolidation breakout.",
  "lesson": "Regime change from bull to range didn't invalidate the trade — patience paid off."
}
```

### 6. Prompt Changes

**Remove:**
- Hardcoded RSI entry ranges (40-65 for LONG, 35-60 for SHORT)
- Hardcoded volume > 1.0x requirement
- "This is LIVE money. Be selective."
- Fixed confluence 3/5 checklist

**Add:**
- Dynamic `CURRENT REGIME` block with regime-specific guidelines
- `ACTIVE FILTERS` block showing the profile for this regime
- `RECENT TRADE STORIES` section (last 5 stories)
- "Be decisive — you are a shark, not a goldfish. Enter when your regime's filters pass."
- "If you override the regime, explain why in `regime_override` + `override_reason`."

**Keep:**
- Multi-timeframe EMA alignment check (but as guideline, not blocker)
- VWAP directional bias
- Funding rate signals
- F&G regime awareness

### 7. File Structure

```
src/market/
  regime-classifier.ts    — rule-based regime classification
  filter-profiles.ts      — adaptive filter sets per regime
src/logging/
  decision-journal.ts     — detailed decision logging
  trade-story.ts          — trade story generation on CLOSE
```

### 8. Data Flow

```
Indicators (1h + 4h)
       │
       ▼
RegimeClassifier.classify(indicators4h, fearGreed, volume)
       │
       ▼
FilterProfiles.getProfile(regime)
       │
       ▼
buildEnrichedPrompt(data + regime + profile + tradeStories)
       │
       ▼
LLM.analyze() → decisions (may include regime_override)
       │
       ▼
DecisionJournal.log(regime, filters, decision, indicators)
       │
       ▼
RiskManager.validate() → OrderExecutor.execute()
       │
       ▼
On CLOSE: TradeStory.generate(trade, regime_entry, regime_exit)
```

### 9. Migration

- Existing `decisions.jsonl` continues as-is (backward compatible)
- New `decision-journal.jsonl` and `trade-stories.jsonl` are additive
- Prompt changes are backwards-compatible (LLM still returns same `decisions` array)
- `regime_override` is optional in response — parsing handles its absence
- Risk manager checks unchanged — still validates everything
