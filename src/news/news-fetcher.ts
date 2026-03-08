import type { NewsEvent } from './types.js';

/**
 * Common interface for all news sources.
 * RssNewsFetcher and future sources implement this.
 */
export interface NewsFetcher {
  fetchNews(limit?: number): Promise<NewsEvent[]>;
}
