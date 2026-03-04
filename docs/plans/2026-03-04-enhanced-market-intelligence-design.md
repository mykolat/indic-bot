# Enhanced Market Intelligence Design

**Goal:** Give the LLM enough market context to make informed trading decisions instead of blind HOLD.

**Problem:** Bot currently sees a single candle snapshot — no trend, no indicators, no news, no sentiment. Like trading with a blindfold.

## Data Sources

| Source | Data | Cost | Frequency |
|--------|------|------|-----------|
| Binance API | 50 candles (1h/4h), funding, OI, long/short ratio | Free | Every cycle |
| Computed | RSI(14), EMA(20/50), ATR(14) | - | Every cycle |
| Apify CryptoPanic | Top news with votes/sentiment per coin | ~$10/mo | Every cycle |
| Alternative.me | Fear & Greed Index (0-100) | Free | Every cycle |

## Technical Indicators (computed locally)

- **RSI(14)** — overbought >70, oversold <30
- **EMA(20) / EMA(50)** — trend direction + crossover signal
- **ATR(14)** — volatility measure for stop-loss sizing

## News Integration

Apify CryptoPanic scraper returns:
```json
{
  "title": "headline",
  "date": "2h",
  "coins": ["BTC"],
  "votes": { "positive": 12, "negative": 2, "important": 5 },
  "source": "coindesk.com"
}
```

Sentiment score = `positive - negative`. Feed top 10 most recent news per cycle.

## Updated Trading Loop

```
1. fetchMarketData (50 candles per pair)    — Binance
2. computeIndicators (RSI, EMA, ATR)        — local
3. fetchNews (CryptoPanic via Apify)        — parallel
4. fetchFearGreed (alternative.me)          — parallel
5. buildEnrichedPrompt                      — combine all
6. LLM analyze                             — Codex API
7. Risk check + execute                    — existing
```

## New Files

- `src/indicators/technical.ts` — RSI, EMA, ATR computation
- `src/news/cryptopanic.ts` — Apify CryptoPanic client
- `src/news/fear-greed.ts` — Fear & Greed Index fetch
- `src/news/types.ts` — shared news types

## Config Additions (.env)

```
APIFY_API_TOKEN=<token>
```

## Updated Prompt Structure

```
## Technical Analysis
### BTCUSDT
Price: $68,350 | 24h: +2.1%
RSI(14): 62 | EMA20: $67,800 | EMA50: $65,200 | ATR: $1,200
Trend: Bullish (EMA20 > EMA50)
Funding: 0.01% | OI: 80,000 BTC
Recent 1h closes: 68100, 68250, 68300, 68200, 68350

## Market Sentiment
Fear & Greed: 72 (Greed)

## News (last 6h)
- [+10/-1] "Bitcoin ETF inflows hit $500M" (BTC) — 2h ago
- [+5/-3] "Fed signals rate pause" (BTC, ETH) — 4h ago

## Portfolio
Balance: $5000 | No open positions
```
