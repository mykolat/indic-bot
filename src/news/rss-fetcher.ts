import { XMLParser } from 'fast-xml-parser';
import type { NewsEvent } from './types.js';
import type { NewsFetcher } from './news-fetcher.js';
import { NEWS_SOURCES, type NewsSource } from './sources.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { insertNewsArticles } from '../db/repository.js';

const RSS_TIMEOUT_MS = 10_000;

export class RssNewsFetcher implements NewsFetcher {
  private parser = new XMLParser({ ignoreAttributes: false });

  constructor(private feeds: NewsSource[] = NEWS_SOURCES) {}

  async fetchNews(limit = 100): Promise<NewsEvent[]> {
    const results = await Promise.allSettled(
      this.feeds.map(feed => this.fetchFeed(feed)),
    );

    const seenUrls = new Set<string>();
    const allItems: NewsEvent[] = [];

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value) {
        if (item.url && seenUrls.has(item.url)) continue;
        if (item.url) seenUrls.add(item.url);
        allItems.push(item);
      }
    }

    allItems.sort((a, b) => {
      const da = new Date(a.date).getTime() || 0;
      const db = new Date(b.date).getTime() || 0;
      return db - da;
    });

    const result = allItems.slice(0, limit);

    insertNewsArticles(result.map(a => ({
      title: a.title,
      source: a.source,
      coins: a.coins,
      sentiment: a.sentiment,
      published_at: a.date || undefined,
    }))).catch(() => {});

    return result;
  }

  private async fetchFeed(feed: NewsSource): Promise<NewsEvent[]> {
    try {
      const response = await fetchWithTimeout(feed.url, { method: 'GET' }, RSS_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const xml = await response.text();
      const parsed = this.parser.parse(xml);
      const items = parsed?.rss?.channel?.item;
      if (!items) return [];

      const arr = Array.isArray(items) ? items : [items];

      return arr.map((item: any): NewsEvent => ({
        title: String(item.title || ''),
        date: String(item.pubDate || ''),
        url: String(item.link || item.guid?.['#text'] || item.guid || ''),
        source: feed.name,
        sourceType: feed.sourceType,
        excerpt: item.description
          ? String(item.description).replace(/<[^>]*>/g, '').slice(0, 200)
          : undefined,
        coins: [],
        sentiment: 0,
        tickers: [],
        topics: [],
        priority: 0,
      }));
    } catch (err) {
      console.error(`[RSS] ${feed.name} error:`, (err as Error).message);
      return [];
    }
  }
}
