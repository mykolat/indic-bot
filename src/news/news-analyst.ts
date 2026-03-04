import type { LLMClient } from '../llm/client.js';
import type { CryptoNews } from './types.js';
import type { NewsAnalysis } from './news-cache.js';

const ANALYST_SYSTEM_PROMPT = `You are a crypto news analyst. Given a list of headlines, return ONLY valid JSON (no markdown, no explanation).

Analyze sentiment, importance, and directional signals for coins mentioned.

Return exactly this structure:
{
  "market_summary": "2-3 sentence narrative of current market conditions",
  "top_signals": [
    {
      "coins": ["BTC"],
      "direction": "bullish",
      "importance": 9,
      "timeframe": "short",
      "catalyst": "one-line trigger",
      "reasoning": "brief analysis",
      "price_impact": "high",
      "expires_hours": 48,
      "source_count": 3,
      "conflicting": false
    }
  ],
  "overall_sentiment": "bullish|bearish|neutral|cautiously_bullish|cautiously_bearish",
  "macro_signals": {
    "fed_stance": "hawkish|dovish|neutral",
    "risk_appetite": "high|moderate|low",
    "dominance_trend": "btc_gaining|altcoin_season|stable"
  },
  "risk_events": ["event1", "event2"]
}

Rules:
- importance 1-10 (10 = market moving)
- Only include signals with importance >= 4
- expires_hours: how long this news stays relevant (6-168)
- conflicting: true if multiple sources disagree on direction
- timeframe: short (<24h), medium (1-7d), long (>7d)`;

const FALLBACK: NewsAnalysis = {
  market_summary: 'News analysis unavailable',
  top_signals: [],
  overall_sentiment: 'neutral',
  macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' },
  risk_events: [],
};

export class NewsAnalystAgent {
  constructor(private llm: Pick<LLMClient, 'call'>) {}

  async analyze(items: CryptoNews[]): Promise<NewsAnalysis> {
    try {
      const headlines = items
        .map((n, i) => `${i + 1}. [${n.coins.join(',') || 'GENERAL'}] ${n.title} (${n.source}, sentiment:${n.sentiment})`)
        .join('\n');

      const userPrompt = `Analyze these ${items.length} crypto headlines:\n\n${headlines}`;

      console.log(`[NewsAnalyst] Analyzing ${items.length} headlines...`);
      const raw = await this.llm.call(ANALYST_SYSTEM_PROMPT, userPrompt);

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return FALLBACK;

      const parsed = JSON.parse(jsonMatch[0]) as NewsAnalysis;
      console.log(`[NewsAnalyst] Done — ${parsed.top_signals?.length ?? 0} signals, sentiment: ${parsed.overall_sentiment}`);
      return parsed;
    } catch (err) {
      console.error('[NewsAnalyst] Error:', err);
      return FALLBACK;
    }
  }
}
