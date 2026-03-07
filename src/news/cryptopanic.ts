import type { CryptoNews } from './types.js';
import type { NewsFetcher } from './news-fetcher.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { insertNewsArticles } from '../db/repository.js';

// Apify REST API requires '~' instead of '/' in actor IDs
const ACTOR_ID = 'piotrv1001~cryptopanic-news-scraper';

export class CryptoPanicClient implements NewsFetcher {
  constructor(private apifyToken: string) { }

  private async triggerAndWait(): Promise<string> {
    const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${this.apifyToken}`;
    const runRes = await fetchWithTimeout(runUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 15_000);
    if (!runRes.ok) throw new Error(`Failed to trigger CryptoPanic actor: ${runRes.status}`);
    const runData = (await runRes.json()) as any;
    const runId = runData.data?.id;
    if (!runId) throw new Error('No runId returned');
    console.log(`[CryptoPanic] Triggered run ${runId}, waiting...`);

    const statusUrl = `https://api.apify.com/v2/actor-runs/${runId}?token=${this.apifyToken}`;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const statusRes = await fetchWithTimeout(statusUrl, {}, 10_000).catch(() => null);
      if (!statusRes?.ok) continue;
      const statusData = (await statusRes.json()) as any;
      const status = statusData.data?.status;
      if (status === 'SUCCEEDED') return statusData.data.defaultDatasetId;
      if (status === 'FAILED' || status === 'ABORTED') throw new Error(`CryptoPanic actor run ${status}`);
    }
    throw new Error('CryptoPanic actor run timed out after 60s');
  }

  async fetchNews(limit = 100): Promise<CryptoNews[]> {
    try {
      let datasetId: string | undefined;

      // Check for a recent successful run (< 3h old)
      const runsUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${this.apifyToken}&desc=true&limit=5`;
      const runsRes = await fetchWithTimeout(runsUrl, {}, 10_000).catch(() => null);

      if (runsRes && runsRes.ok) {
        const runsData = (await runsRes.json()) as any;
        const recentRuns = runsData.data?.items || [];
        const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
        const lastSuccess = recentRuns.find((r: any) =>
          r.status === 'SUCCEEDED' && new Date(r.finishedAt).getTime() > threeHoursAgo,
        );
        if (lastSuccess) {
          console.log(`[CryptoPanic] Using cached run: ${lastSuccess.id}`);
          datasetId = lastSuccess.defaultDatasetId;
        }
      }

      if (!datasetId) {
        console.log('[CryptoPanic] No recent run — triggering on-demand...');
        datasetId = await this.triggerAndWait();
      }

      // Fetch its items directly
      const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${this.apifyToken}`;
      const datasetRes = await fetchWithTimeout(datasetUrl, {}, 15_000);
      if (!datasetRes.ok) {
        throw new Error(`Failed to fetch dataset ${datasetId}`);
      }
      const items = (await datasetRes.json()) as any[];

      const articles = items.slice(0, limit).map((item) => ({
        title: item.title || '',
        date: item.date || '',
        coins: Array.isArray(item.coins) ? item.coins : [],
        sentiment: this.computeSentiment(item.votes),
        source: item.source || '',
      }));

      // Dual-write to DB
      insertNewsArticles(articles.map(a => ({
        title: a.title,
        source: a.source || 'cryptopanic',
        coins: a.coins,
        sentiment: a.sentiment,
        published_at: a.date || undefined,
      }))).catch(() => {});

      return articles;
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

