import type { TradeDecision } from '../risk/manager.js';

export interface OrderResult {
  success: boolean;
  orderId?: number;
  error?: string;
}

export class OrderExecutor {
  constructor(private client: any) {}

  async execute(decision: TradeDecision, balanceUsd: number): Promise<OrderResult> {
    try {
      const side = decision.action === 'LONG' ? 'BUY' : 'SELL';
      const closeSide = decision.action === 'LONG' ? 'SELL' : 'BUY';

      await this.client.setLeverage({ symbol: decision.pair, leverage: decision.leverage });

      const ticker = await this.client.getSymbolPriceTicker({ symbol: decision.pair });
      const price = parseFloat(ticker.price);
      const positionUsd = (decision.size_pct / 100) * balanceUsd * decision.leverage;
      const quantity = this.roundQuantity(positionUsd / price, decision.pair);

      const order = await this.client.submitNewOrder({
        symbol: decision.pair,
        side,
        type: 'MARKET',
        quantity: String(quantity),
      });

      const stopPrice = decision.action === 'LONG'
        ? price * (1 - decision.stop_loss_pct / 100)
        : price * (1 + decision.stop_loss_pct / 100);

      await this.client.submitNewOrder({
        symbol: decision.pair,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: String(this.roundPrice(stopPrice)),
        quantity: String(quantity),
        reduceOnly: 'true',
      });

      return { success: true, orderId: order.orderId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async close(pair: string, quantity: number, side: 'LONG' | 'SHORT'): Promise<OrderResult> {
    try {
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
      const order = await this.client.submitNewOrder({
        symbol: pair,
        side: closeSide,
        type: 'MARKET',
        quantity: String(quantity),
        reduceOnly: 'true',
      });
      return { success: true, orderId: order.orderId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private roundQuantity(qty: number, pair: string): number {
    const decimals = pair.includes('BTC') ? 3 : pair.includes('ETH') ? 2 : 1;
    return Math.floor(qty * 10 ** decimals) / 10 ** decimals;
  }

  private roundPrice(price: number): number {
    return Math.round(price * 100) / 100;
  }
}
