import type { TradeDecision } from '../risk/manager.js';

export interface OrderResult {
  success: boolean;
  orderId?: number;
  error?: string;
  fillPrice?: number;
}

export class OrderExecutor {
  constructor(private client: any) { }

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

      let fillPrice = price; // fallback
      if (order.fills && order.fills.length > 0) {
        let totalQty = 0;
        let totalCost = 0;
        for (const fill of order.fills) {
          totalQty += parseFloat(fill.qty);
          totalCost += parseFloat(fill.price) * parseFloat(fill.qty);
        }
        if (totalQty > 0) fillPrice = totalCost / totalQty;
      } else if (order.price && parseFloat(order.price) > 0) {
        fillPrice = parseFloat(order.price);
      }

      console.log(`[Orders] Executed ${decision.action} on ${decision.pair}. Trigger: ${price}, Fill: ${fillPrice.toFixed(4)}`);

      const stopPrice = decision.action === 'LONG'
        ? fillPrice * (1 - decision.stop_loss_pct / 100)
        : fillPrice * (1 + decision.stop_loss_pct / 100);

      const tpPrice = decision.action === 'LONG'
        ? fillPrice * (1 + decision.take_profit_pct / 100)
        : fillPrice * (1 - decision.take_profit_pct / 100);

      // Stop-Loss (MANDATORY — fail = cancel trade)
      try {
        await this.client.submitNewOrder({
          symbol: decision.pair,
          side: closeSide,
          type: 'STOP_MARKET',
          stopPrice: String(this.roundPrice(stopPrice)),
          closePosition: 'true',
        });
      } catch (slErr: any) {
        console.error(`[Orders] SL placement FAILED for ${decision.pair} — closing position!`, slErr.message);
        // Close the entry position immediately
        try {
          const positions = await this.client.getPositions({ symbol: decision.pair });
          const pos = positions.find((p: any) => p.symbol === decision.pair && parseFloat(p.positionAmt) !== 0);
          const closeQty = pos ? Math.abs(parseFloat(pos.positionAmt)) : quantity;
          await this.client.submitNewOrder({
            symbol: decision.pair,
            side: closeSide,
            type: 'MARKET',
            quantity: String(closeQty),
            reduceOnly: 'true',
          });
        } catch (closeErr: any) {
          console.error(`[Orders] CRITICAL: Failed to close unprotected position ${decision.pair}!`, closeErr.message);
        }
        return { success: false, error: `SL failed: ${slErr.message} — position closed` };
      }

      try {
        await this.client.submitNewOrder({
          symbol: decision.pair,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(this.roundPrice(tpPrice)),
          closePosition: 'true',
        });
      } catch (tpErr: any) {
        console.error(`[Orders] TP placement failed for ${decision.pair}: ${tpErr.message}`);
      }

      return { success: true, orderId: order.orderId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async close(pair: string, side: 'LONG' | 'SHORT'): Promise<OrderResult> {
    try {
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

      // Fetch exact position size from Binance to avoid precision errors
      const positions = await this.client.getPositions({ symbol: pair });
      const pos = positions.find((p: any) => p.symbol === pair && parseFloat(p.positionAmt) !== 0);
      if (!pos) {
        return { success: false, error: `No open position found for ${pair}` };
      }
      const quantity = Math.abs(parseFloat(pos.positionAmt));

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
