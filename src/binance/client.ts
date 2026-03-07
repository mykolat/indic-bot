import { USDMClient } from 'binance';

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export function createBinanceClient(config: BinanceConfig): USDMClient {
  const mode = config.testnet ? 'TESTNET (demo-fapi)' : 'LIVE';
  console.log(`[Binance] Mode: ${mode}`);

  return new USDMClient({
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    recvWindow: 10000,
    ...(config.testnet && { baseUrl: 'https://demo-fapi.binance.com' }),
  });
}
