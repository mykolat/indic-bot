import type { CryptoNews } from './types.js';

// Apify REST API requires '~' instead of '/' in actor IDs
const ACTOR_ID = 'piotrv1001~cryptopanic-news-scraper';

export class CryptoPanicClient {
  constructor(private apifyToken: string) {}

  async fetchNews(limit = 100): Promise<CryptoNews[]> {
    try {
      // Run the actor and wait for it to finish
      const runResponse = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${this.apifyToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'top-news', filter: 'show-all' }),
        },
      );

      if (!runResponse.ok) {
        const errText = await runResponse.text().catch(() => '');
        throw new Error(`Apify API ${runResponse.status}: ${errText.slice(0, 200)}`);
      }

      const items = (await runResponse.json()) as any[];

      return items.slice(0, limit).map((item) => ({
        title: item.title || '',
        date: item.date || '',
        coins: Array.isArray(item.coins) ? item.coins : [],
        sentiment: this.computeSentiment(item.votes),
        source: item.source || '',
      }));
    } catch (err) {
      console.error('[CryptoPanic] Error:', err);
      return [];
    }
  }

  private computeSentiment(votes: any): number {
    if (!votes) return 0;
    const positive = (votes.positive || 0) + (votes.like || 0);
    const negative = (votes.negative || 0) + (votes.dislike || 0);
    return positive - negative;
  }
}
