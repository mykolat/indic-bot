import { XMLParser } from 'fast-xml-parser';
import type { CryptoNews } from './types.js';
import type { NewsFetcher } from './news-fetcher.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { insertNewsArticles } from '../db/repository.js';

export interface RssFeedSource {
  name: string;
  url: string;
}

const DEFAULT_FEEDS: RssFeedSource[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const RSS_TIMEOUT_MS = 10_000;

export class RssNewsFetcher implements NewsFetcher {
  private parser = new XMLParser({ ignoreAttributes: true });

  constructor(private feeds: RssFeedSource[] = DEFAULT_FEEDS) {}

  async fetchNews(limit = 100): Promise<CryptoNews[]> {
    const results = await Promise.allSettled(
      this.feeds.map((feed) => this.fetchFeed(feed)),
    );

    const allItems: CryptoNews[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      }
    }

    allItems.sort((a, b) => {
      const da = new Date(a.date).getTime() || 0;
      const db = new Date(b.date).getTime() || 0;
      return db - da;
    });

    // Dual-write to DB
    const result = allItems.slice(0, limit);
    insertNewsArticles(result.map(a => ({
      title: a.title,
      source: a.source || 'rss',
      coins: a.coins,
      sentiment: a.sentiment,
      published_at: a.date || undefined,
    }))).catch(() => {});

    return result;
  }

  private async fetchFeed(feed: RssFeedSource): Promise<CryptoNews[]> {
    try {
      const response = await fetchWithTimeout(
        feed.url,
        { method: 'GET' },
        RSS_TIMEOUT_MS,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xml = await response.text();
      const parsed = this.parser.parse(xml);
      const items = parsed?.rss?.channel?.item;
      if (!items) return [];

      const arr = Array.isArray(items) ? items : [items];

      return arr.map((item: any) => ({
        title: item.title || '',
        date: item.pubDate || '',
        coins: [],
        sentiment: 0,
        source: feed.name,
      }));
    } catch (err) {
      console.error(`[RSS] ${feed.name} error:`, (err as Error).message);
      return [];
    }
  }
}
