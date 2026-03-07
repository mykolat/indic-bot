import type { TradeDecision } from '../risk/manager.js';

/** Convert a Binance step/tick size string (e.g. "0.0001") to decimal count (4). */
export function computeDecimalsFromStep(stepStr: string): number {
  const step = parseFloat(stepStr);
  if (step >= 1) return 0;
  // Count decimal places from the string to avoid float precision issues
  const parts = stepStr.replace(/0+$/, '').split('.');
  return parts.length > 1 ? parts[1].length : 0;
}

export interface OrderResult {
  success: boolean;
  orderId?: number;
  error?: string;
  fillPrice?: number;
  slPrice?: number;
  tpPrice?: number;
  quantity?: number;
  commissionUsd?: number;
  commissionAsset?: string;
}

export interface EntryOptions {
  useLimitEntry?: boolean;
  limitEntryTimeoutMs?: number;
}

export class OrderExecutor {
  private stepDecimals: Map<string, number>;
  private priceDecimals: Map<string, number>;
  private entryOptions: EntryOptions;

  constructor(
    private client: any,
    stepDecimals?: Map<string, number>,
    priceDecimals?: Map<string, number>,
    entryOptions?: EntryOptions,
  ) {
    this.stepDecimals = stepDecimals ?? new Map();
    this.priceDecimals = priceDecimals ?? new Map();
    this.entryOptions = entryOptions ?? {};
  }

  async execute(decision: TradeDecision, balanceUsd: number): Promise<OrderResult> {
    try {
      const side = decision.action === 'LONG' ? 'BUY' : 'SELL';
      const closeSide = decision.action === 'LONG' ? 'SELL' : 'BUY';

      await this.client.setLeverage({ symbol: decision.pair, leverage: decision.leverage });

      const ticker = await this.client.getSymbolPriceTicker({ symbol: decision.pair });
      const price = parseFloat(ticker.price);
      const positionUsd = (decision.size_pct / 100) * balanceUsd * decision.leverage;
      const quantity = this.roundQuantity(positionUsd / price, decision.pair);

      let order: any;

      // Attempt LIMIT entry if enabled
      if (this.entryOptions.useLimitEntry) {
        try {
          const attempt = await this.attemptLimitEntry(decision.pair, side, quantity);
          if (attempt.filled) {
            order = attempt.order;
          }
        } catch (err: any) {
          console.error(`[Orders] LIMIT attempt failed: ${err.message}, using MARKET`);
        }
      }

      // MARKET fallback (or default path)
      if (!order) {
        order = await this.client.submitNewOrder({
          symbol: decision.pair,
          side,
          type: 'MARKET',
          quantity: String(quantity),
        });
      }

      let fillPrice = price; // fallback
      let commissionUsd = 0;
      let commissionAsset = 'USDT';
      if (order.fills && order.fills.length > 0) {
        let totalQty = 0;
        let totalCost = 0;
        for (const fill of order.fills) {
          totalQty += parseFloat(fill.qty);
          totalCost += parseFloat(fill.price) * parseFloat(fill.qty);
          if (fill.commission) commissionUsd += parseFloat(fill.commission);
          if (fill.commissionAsset) commissionAsset = fill.commissionAsset;
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
        await this.client.submitNewAlgoOrder({
          symbol: decision.pair,
          side: closeSide,
          algoType: 'CONDITIONAL',
          type: 'STOP_MARKET',
          triggerPrice: this.formatPrice(stopPrice, decision.pair),
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
        await this.client.submitNewAlgoOrder({
          symbol: decision.pair,
          side: closeSide,
          algoType: 'CONDITIONAL',
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: this.formatPrice(tpPrice, decision.pair),
          closePosition: 'true',
        });
      } catch (tpErr: any) {
        console.error(`[Orders] TP placement failed for ${decision.pair}: ${tpErr.message}`);
      }

      return { success: true, orderId: order.orderId, fillPrice, slPrice: stopPrice, tpPrice, quantity, commissionUsd, commissionAsset };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async close(pair: string, side: 'LONG' | 'SHORT'): Promise<OrderResult> {
    try {
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

      // Cancel orphaned algo orders (SL/TP) to prevent them firing on future positions
      try {
        await this.client.cancelAllAlgoOpenOrders({ symbol: pair });
      } catch {
        // Ignore — may have no algo orders to cancel
      }

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

  async adjustSlTp(params: {
    pair: string;
    side: 'LONG' | 'SHORT';
    newSlPrice: number;
    newTpPrice: number;
  }): Promise<OrderResult> {
    const { pair, side, newSlPrice, newTpPrice } = params;
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

    try {
      // 1. Cancel all existing algo orders for this pair
      try {
        await this.client.cancelAllAlgoOpenOrders({ symbol: pair });
      } catch {
        // May have no algo orders — continue
      }

      // 2. Place new SL (mandatory — fail = abort adjustment)
      await this.client.submitNewAlgoOrder({
        symbol: pair,
        side: closeSide,
        algoType: 'CONDITIONAL',
        type: 'STOP_MARKET',
        triggerPrice: this.formatPrice(newSlPrice, pair),
        closePosition: 'true',
      });

      // 3. Place new TP (best-effort)
      try {
        await this.client.submitNewAlgoOrder({
          symbol: pair,
          side: closeSide,
          algoType: 'CONDITIONAL',
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: this.formatPrice(newTpPrice, pair),
          closePosition: 'true',
        });
      } catch (tpErr: any) {
        console.error(`[Orders] TP adjustment failed for ${pair}: ${tpErr.message}`);
      }

      console.log(`[Orders] Adjusted ${pair} ${side}: SL→$${newSlPrice.toFixed(4)}, TP→$${newTpPrice.toFixed(4)}`);
      return { success: true, slPrice: newSlPrice, tpPrice: newTpPrice };
    } catch (err: any) {
      console.error(`[Orders] SL adjustment FAILED for ${pair}: ${err.message}`);
      return { success: false, error: `Adjust SL failed: ${err.message}` };
    }
  }

  async partialClose(pair: string, side: 'LONG' | 'SHORT', ratio: number): Promise<OrderResult> {
    try {
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
      const positions = await this.client.getPositions({ symbol: pair });
      const pos = positions.find((p: any) => p.symbol === pair && parseFloat(p.positionAmt) !== 0);
      if (!pos) {
        return { success: false, error: `No open position found for ${pair}` };
      }
      const fullQty = Math.abs(parseFloat(pos.positionAmt));
      const partialQty = this.roundQuantity(fullQty * ratio, pair);
      if (partialQty <= 0) {
        return { success: false, error: `Partial quantity too small for ${pair}` };
      }

      const order = await this.client.submitNewOrder({
        symbol: pair,
        side: closeSide,
        type: 'MARKET',
        quantity: String(partialQty),
        reduceOnly: 'true',
      });

      console.log(`[Orders] Partial close ${pair} ${side}: ${(ratio * 100).toFixed(0)}% (${partialQty})`);
      return { success: true, orderId: order.orderId, quantity: partialQty };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async moveSlToBreakeven(pair: string, side: 'LONG' | 'SHORT', entryPrice: number, bufferPct: number): Promise<OrderResult> {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    try {
      // Cancel existing algo orders
      try {
        await this.client.cancelAllAlgoOpenOrders({ symbol: pair });
      } catch {
        // May have no algo orders
      }

      // Breakeven = entry + buffer (above for LONG, below for SHORT)
      const bePrice = side === 'LONG'
        ? entryPrice * (1 + bufferPct / 100)
        : entryPrice * (1 - bufferPct / 100);

      await this.client.submitNewAlgoOrder({
        symbol: pair,
        side: closeSide,
        algoType: 'CONDITIONAL',
        type: 'STOP_MARKET',
        triggerPrice: this.formatPrice(bePrice, pair),
        closePosition: 'true',
      });

      console.log(`[Orders] Moved SL to breakeven ${pair} ${side}: $${bePrice.toFixed(4)}`);
      return { success: true, slPrice: bePrice };
    } catch (err: any) {
      console.error(`[Orders] Breakeven SL FAILED for ${pair}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  private async attemptLimitEntry(
    pair: string, side: string, quantity: number,
  ): Promise<{ filled: boolean; order?: any }> {
    const book = await this.client.getOrderBook({ symbol: pair, limit: 5 });
    const limitPrice = side === 'BUY'
      ? parseFloat(book.bids[0][0])   // best bid for LONG
      : parseFloat(book.asks[0][0]);  // best ask for SHORT

    const order = await this.client.submitNewOrder({
      symbol: pair,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(quantity),
      price: this.formatPrice(limitPrice, pair),
    });

    if (order.status === 'FILLED') {
      return { filled: true, order };
    }

    const timeout = this.entryOptions.limitEntryTimeoutMs ?? 3000;
    if (timeout > 0) await new Promise(r => setTimeout(r, timeout));

    const status = await this.client.getOrder({ symbol: pair, orderId: order.orderId });
    if (status.status === 'FILLED') {
      return { filled: true, order: status };
    }

    await this.client.cancelOrder({ symbol: pair, orderId: order.orderId }).catch(() => {});
    console.log(`[Orders] LIMIT not filled for ${pair}, falling back to MARKET`);
    return { filled: false };
  }

  private roundQuantity(qty: number, pair: string): number {
    const decimals = this.stepDecimals.get(pair)
      ?? (pair.includes('BTC') ? 3 : pair.includes('ETH') ? 2 : 1);
    return Math.floor(qty * 10 ** decimals) / 10 ** decimals;
  }

  private formatPrice(price: number, pair: string): string {
    const decimals = this.priceDecimals.get(pair) ?? 2;
    const factor = 10 ** decimals;
    const rounded = Math.round(price * factor) / factor;
    return decimals > 0 ? rounded.toFixed(decimals) : String(rounded);
  }
}
