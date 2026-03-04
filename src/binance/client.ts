import { USDMClient } from 'binance';

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export function createBinanceClient(config: BinanceConfig): USDMClient {
  const mode = config.testnet ? 'TESTNET' : 'LIVE';
  console.log(`[Binance] Mode: ${mode}`);

  return new USDMClient({
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    ...(config.testnet && { useTestnet: true }),
  });
}
