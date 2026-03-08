import type { LLMClient } from '../llm/client.js';
import type { NewsEvent } from './types.js';

const ENRICH_BATCH = 50;

const SYSTEM_PROMPT = `You are a crypto news tagger. Given an array of news items, return ONLY a JSON array (no markdown) with one object per item in the same order.

Each object: { "tickers": string[], "topics": string[], "priority": number }

- tickers: crypto symbols mentioned or implied (["BTC", "ETH", "SOL", ...]). Empty [] if none.
- topics: from this list only: ETF, Regulation, Listing, Delisting, Hack, Exploit, Upgrade, Launch, Partnership, Macro, Stablecoin, Governance, Airdrop, Earnings, Other
- priority: 0.0–1.0 where 1.0 = market-moving (ETF approval, major hack, exchange collapse). 0.0 = opinion/recap.

Return exactly as many objects as input items, in the same order.`;

export class NewsEnricher {
  constructor(private llm: Pick<LLMClient, 'call'>) {}

  async enrich(events: NewsEvent[]): Promise<NewsEvent[]> {
    if (events.length === 0) return events;

    const batch = events.slice(0, ENRICH_BATCH);
    const passthrough = events.slice(ENRICH_BATCH);

    try {
      const input = batch.map((e, i) => `${i + 1}. [${e.source}/${e.sourceType}] ${e.title}`).join('\n');
      const raw = await this.llm.call(SYSTEM_PROMPT, `Tag these ${batch.length} news items:\n\n${input}`);

      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const tags = JSON.parse(jsonMatch[0]) as Array<{ tickers: string[]; topics: string[]; priority: number }>;

      const enriched = batch.map((e, i) => {
        const tag = tags[i];
        if (!tag) return e;
        return { ...e, tickers: tag.tickers ?? [], topics: tag.topics ?? [], priority: tag.priority ?? 0 };
      });

      console.log(`[NewsEnricher] Enriched ${enriched.length} events`);
      return [...enriched, ...passthrough];
    } catch (err) {
      console.error('[NewsEnricher] Failed, returning unenriched:', (err as Error).message);
      return events;
    }
  }
}
