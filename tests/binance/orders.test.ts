import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderExecutor } from '../../src/binance/orders.js';
import type { TradeDecision } from '../../src/risk/manager.js';

describe('OrderExecutor', () => {
  let executor: OrderExecutor;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
      submitNewOrder: vi.fn().mockResolvedValue({
        orderId: 123456,
        symbol: 'BTCUSDT',
        status: 'NEW',
        side: 'BUY',
        type: 'MARKET',
      }),
      getSymbolPriceTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', price: '50000.00' }),
      getPositions: vi.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', positionAmt: '0.001' },
      ]),
    };
    executor = new OrderExecutor(mockClient);
  });

  it('opens a LONG position with market order + stop-loss + take-profit', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);

    expect(mockClient.setLeverage).toHaveBeenCalledWith({ symbol: 'BTCUSDT', leverage: 10 });
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);

    const stopCall = mockClient.submitNewOrder.mock.calls[1][0];
    expect(stopCall.type).toBe('STOP_MARKET');
    expect(stopCall.closePosition).toBe('true');
    expect(stopCall.reduceOnly).toBeUndefined();

    const tpCall = mockClient.submitNewOrder.mock.calls[2][0];
    expect(tpCall.type).toBe('TAKE_PROFIT_MARKET');
    expect(tpCall.closePosition).toBe('true');
    expect(tpCall.reduceOnly).toBeUndefined();
  });

  it('stop price is below entry for LONG, above for SHORT', async () => {
    const longDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    await executor.execute(longDecision, 10);
    const stopCall = mockClient.submitNewOrder.mock.calls[1][0];
    expect(parseFloat(stopCall.stopPrice)).toBeLessThan(50000);

    mockClient.submitNewOrder.mockClear();

    const shortDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'SHORT', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    await executor.execute(shortDecision, 10);
    const shortStopCall = mockClient.submitNewOrder.mock.calls[1][0];
    expect(parseFloat(shortStopCall.stopPrice)).toBeGreaterThan(50000);
  });

  it('take-profit price is above entry for LONG', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    await executor.execute(decision, 10);
    const tpCall = mockClient.submitNewOrder.mock.calls[2][0];
    expect(parseFloat(tpCall.stopPrice)).toBeGreaterThan(50000);
  });

  it('opens a SHORT position', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'SHORT', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);
    const marketCall = mockClient.submitNewOrder.mock.calls[0][0];
    expect(marketCall.side).toBe('SELL');
    expect(result.success).toBe(true);
  });

  it('closes a position', async () => {
    const result = await executor.close('BTCUSDT', 'LONG');
    expect(mockClient.getPositions).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1);
    const call = mockClient.submitNewOrder.mock.calls[0][0];
    expect(call.reduceOnly).toBe('true');
    expect(result.success).toBe(true);
  });

  it('returns error on API failure', async () => {
    mockClient.submitNewOrder.mockRejectedValue(new Error('Insufficient margin'));

    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient margin');
  });
});
