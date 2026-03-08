export interface CryptoNews {
  title: string;
  date: string;
  coins: string[];
  sentiment: number; // positive - negative
  source: string;
}

export interface FearGreedData {
  value: number; // 0-100
  label: string; // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
}

export type SourceType = 'newsroom' | 'research' | 'venue' | 'protocol';

export interface NewsEvent extends CryptoNews {
  url: string;
  sourceType: SourceType;
  tickers: string[];     // crypto symbols — populated by enricher
  topics: string[];      // ['ETF', 'Regulation', 'Listing', 'Hack', ...]
  priority: number;      // 0–1, LLM-assigned
  excerpt?: string;
}
