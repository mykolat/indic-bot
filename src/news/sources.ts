import type { SourceType } from './types.js';

export interface NewsSource {
  name: string;
  url: string;
  sourceType: SourceType;
  priority: number;  // 1 = highest, 2 = lower tier
}

export const NEWS_SOURCES: NewsSource[] = [
  // Tier 1 — newsrooms
  { name: 'CoinDesk',      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', sourceType: 'newsroom', priority: 1 },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss',                   sourceType: 'newsroom', priority: 1 },
  { name: 'The Block',     url: 'https://www.theblock.co/rss.xml',                 sourceType: 'newsroom', priority: 1 },
  { name: 'Blockworks',    url: 'https://blockworks.co/feed',                      sourceType: 'newsroom', priority: 1 },
  { name: 'Decrypt',       url: 'https://decrypt.co/feed',                         sourceType: 'newsroom', priority: 1 },
  { name: 'DL News',       url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',   sourceType: 'newsroom', priority: 1 },
  { name: 'The Defiant',   url: 'https://thedefiant.io/feed',                      sourceType: 'newsroom', priority: 1 },
  // Tier 4 — official venues/issuers
  { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog/index.xml',         sourceType: 'venue', priority: 1 },
  { name: 'Binance Blog',  url: 'https://www.binance.com/en/feed',                 sourceType: 'venue', priority: 1 },
  { name: 'Kraken Blog',   url: 'https://blog.kraken.com/feed',                    sourceType: 'venue', priority: 1 },
  { name: 'Circle Blog',   url: 'https://www.circle.com/blog/rss.xml',             sourceType: 'venue', priority: 1 },
  { name: 'Tether News',   url: 'https://tether.to/en/feed/',                      sourceType: 'venue', priority: 1 },
  // Tier 5 — official protocols
  { name: 'Uniswap Labs',        url: 'https://blog.uniswap.org/rss.xml',            sourceType: 'protocol', priority: 2 },
  { name: 'Ethereum Foundation', url: 'https://blog.ethereum.org/en/feed.xml',       sourceType: 'protocol', priority: 2 },
  { name: 'Chainalysis Blog',    url: 'https://www.chainalysis.com/blog/feed.xml',   sourceType: 'research', priority: 2 },
];

export function getSourceByName(name: string): NewsSource | undefined {
  return NEWS_SOURCES.find(s => s.name === name);
}
