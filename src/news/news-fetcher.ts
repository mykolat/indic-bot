import type { CryptoNews } from './types.js';

/**
 * Common interface for all news sources.
 * CryptoPanicClient, RssNewsFetcher, and future paid sources implement this.
 */
export interface NewsFetcher {
  fetchNews(limit?: number): Promise<CryptoNews[]>;
}
