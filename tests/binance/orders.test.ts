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
    };
    executor = new OrderExecutor(mockClient);
  });

  it('opens a LONG position with market order + stop-loss', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);

    expect(mockClient.setLeverage).toHaveBeenCalledWith({ symbol: 'BTCUSDT', leverage: 10 });
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
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
    const result = await executor.close('BTCUSDT', 0.001, 'LONG');
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1);
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
