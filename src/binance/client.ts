import { USDMClient } from 'binance';

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export function createBinanceClient(config: BinanceConfig): USDMClient {
  return new USDMClient({
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    ...(config.testnet && { baseUrl: 'https://testnet.binancefuture.com' }),
  });
}
