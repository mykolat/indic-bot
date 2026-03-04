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
