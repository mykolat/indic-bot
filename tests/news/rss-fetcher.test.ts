import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssNewsFetcher } from '../../src/news/rss-fetcher.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));
vi.mock('../../src/db/repository.js', () => ({ insertNewsArticles: vi.fn().mockResolvedValue(undefined) }));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

const makeRss = (items: { title: string; link: string; pubDate: string; description?: string }[]) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
${items.map(i => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate><description>${i.description ?? ''}</description></item>`).join('\n')}
</channel></rss>`;

describe('RssNewsFetcher', () => {
  let fetcher: RssNewsFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use only 2 test sources to keep mock setup simple
    fetcher = new RssNewsFetcher([
      { name: 'CoinDesk', url: 'https://coindesk.com/rss', sourceType: 'newsroom', priority: 1 },
      { name: 'Binance Blog', url: 'https://binance.com/feed', sourceType: 'venue', priority: 1 },
    ]);
  });

  it('returns NewsEvent[] with url and sourceType', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => makeRss([
      { title: 'BTC ATH', link: 'https://coindesk.com/btc', pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000', description: 'Bitcoin hits 200k' },
    ]) } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews(10);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://coindesk.com/btc');
    expect(items[0].sourceType).toBe('newsroom');
    expect(items[0].tickers).toEqual([]);
    expect(items[0].topics).toEqual([]);
    expect(items[0].priority).toBe(0);
    expect(items[0].excerpt).toBe('Bitcoin hits 200k');
  });

  it('deduplicates by exact URL within one fetch', async () => {
    const dupRss = makeRss([
      { title: 'BTC news', link: 'https://coindesk.com/same', pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000' },
      { title: 'BTC news duplicate', link: 'https://coindesk.com/same', pubDate: 'Wed, 05 Mar 2026 10:01:00 +0000' },
    ]);
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => dupRss } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews(100);
    expect(items).toHaveLength(1);
  });

  it('returns empty array when all feeds fail', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const items = await fetcher.fetchNews();
    expect(items).toEqual([]);
  });

  it('sorts by date newest first', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => makeRss([
      { title: 'Old', link: 'https://coindesk.com/old', pubDate: 'Mon, 03 Mar 2026 10:00:00 +0000' },
      { title: 'New', link: 'https://coindesk.com/new', pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000' },
    ]) } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const items = await fetcher.fetchNews();
    expect(items[0].title).toBe('New');
  });

  it('respects limit', async () => {
    const items20 = Array.from({ length: 20 }, (_, i) => ({
      title: `Article ${i}`, link: `https://coindesk.com/${i}`, pubDate: 'Wed, 05 Mar 2026 10:00:00 +0000',
    }));
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => makeRss(items20) } as any);
    mockFetch.mockRejectedValueOnce(new Error('fail'));

    const result = await fetcher.fetchNews(5);
    expect(result).toHaveLength(5);
  });
});
