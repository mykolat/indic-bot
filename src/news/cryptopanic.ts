import type { CryptoNews } from './types.js';
import type { NewsFetcher } from './news-fetcher.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

// Apify REST API requires '~' instead of '/' in actor IDs
const ACTOR_ID = 'piotrv1001~cryptopanic-news-scraper';

export class CryptoPanicClient implements NewsFetcher {
  constructor(private apifyToken: string) { }

  async fetchNews(limit = 100): Promise<CryptoNews[]> {
    try {
      let datasetId: string | undefined;

      // Fetch the latest successful run (Actors are scheduled externally)
      const runsUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${this.apifyToken}&desc=true&limit=5`;
      const runsRes = await fetchWithTimeout(runsUrl, {}, 10_000).catch(() => null);

      if (runsRes && runsRes.ok) {
        const runsData = (await runsRes.json()) as any;
        const recentRuns = runsData.data?.items || [];
        const lastSuccess = recentRuns.find((r: any) => r.status === 'SUCCEEDED');

        if (lastSuccess) {
          console.log(`[CryptoPanic] Using dataset from scheduled run: ${lastSuccess.id}`);
          datasetId = lastSuccess.defaultDatasetId;
        }
      }

      if (!datasetId) {
        throw new Error(`No successful runs found for actor ${ACTOR_ID}`);
      }

      // Fetch its items directly
      const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${this.apifyToken}`;
      const datasetRes = await fetchWithTimeout(datasetUrl, {}, 15_000);
      if (!datasetRes.ok) {
        throw new Error(`Failed to fetch dataset ${datasetId}`);
      }
      const items = (await datasetRes.json()) as any[];

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

