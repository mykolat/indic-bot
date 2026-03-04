import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssNewsFetcher } from '../../src/news/rss-fetcher.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

const COINDESK_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Bitcoin hits new high</title>
      <link>https://coindesk.com/btc</link>
      <pubDate>Wed, 05 Mar 2026 10:00:00 +0000</pubDate>
      <description>BTC surges past 100k</description>
    </item>
  </channel>
</rss>`;

const COINTELEGRAPH_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>ETH DeFi boom</title>
      <link>https://cointelegraph.com/eth</link>
      <pubDate>Wed, 05 Mar 2026 09:00:00 +0000</pubDate>
      <description>Ethereum DeFi TVL up</description>
    </item>
  </channel>
</rss>`;

describe('RssNewsFetcher', () => {
  let fetcher: RssNewsFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new RssNewsFetcher();
  });

  it('fetches and merges articles from multiple RSS feeds', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => COINDESK_RSS } as any);
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => COINTELEGRAPH_RSS } as any);
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const items = await fetcher.fetchNews(100);

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Bitcoin hits new high');
    expect(items[0].source).toBe('CoinDesk');
    expect(items[0].date).toBe('Wed, 05 Mar 2026 10:00:00 +0000');
    expect(items[0].coins).toEqual([]);
    expect(items[0].sentiment).toBe(0);
    expect(items[1].source).toBe('CoinTelegraph');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns empty array when all feeds fail', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const items = await fetcher.fetchNews();
    expect(items).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const bigRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      ${Array.from({ length: 20 }, (_, i) => `<item><title>Article ${i}</title><link>https://x.com/${i}</link><pubDate>Wed, 05 Mar 2026 10:00:00 +0000</pubDate><description>desc</description></item>`).join('')}
    </channel></rss>`;

    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => bigRss } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews(5);
    expect(items).toHaveLength(5);
  });

  it('handles non-ok HTTP response gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews();
    expect(items).toEqual([]);
  });

  it('sorts articles by date (newest first)', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <item><title>Old</title><link>https://x.com/1</link><pubDate>Mon, 03 Mar 2026 10:00:00 +0000</pubDate><description>old</description></item>
      <item><title>New</title><link>https://x.com/2</link><pubDate>Wed, 05 Mar 2026 10:00:00 +0000</pubDate><description>new</description></item>
    </channel></rss>`;

    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => rss } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews();
    expect(items[0].title).toBe('New');
    expect(items[1].title).toBe('Old');
  });
});
