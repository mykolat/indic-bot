import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderExecutor, computeDecimalsFromStep } from '../../src/binance/orders.js';
import type { TradeDecision } from '../../src/risk/manager.js';

describe('computeDecimalsFromStep', () => {
  it('returns 0 for stepSize >= 1', () => {
    expect(computeDecimalsFromStep('1')).toBe(0);
    expect(computeDecimalsFromStep('10')).toBe(0);
  });

  it('returns correct decimals for fractional stepSize', () => {
    expect(computeDecimalsFromStep('0.1')).toBe(1);      // BTCUSDT tickSize
    expect(computeDecimalsFromStep('0.01')).toBe(2);     // ETHUSDT tickSize
    expect(computeDecimalsFromStep('0.0001')).toBe(4);   // XRPUSDT tickSize
    expect(computeDecimalsFromStep('0.00001')).toBe(5);  // DOGEUSDT tickSize
    expect(computeDecimalsFromStep('0.001')).toBe(3);    // SOLUSDT stepSize
  });

  it('handles edge case of stepSize with trailing zeros', () => {
    expect(computeDecimalsFromStep('0.00010')).toBe(4);  // trailing zero
    expect(computeDecimalsFromStep('0.10000')).toBe(1);
  });
});

describe('computeDecimalsFromStep — all configured pairs', () => {
  // Real Binance exchangeInfo tickSize values as of 2026-03
  const PAIR_TICK_SIZES: Record<string, string> = {
    BTCUSDT: '0.10',
    ETHUSDT: '0.01',
    SOLUSDT: '0.010',
    BNBUSDT: '0.010',
    XRPUSDT: '0.0001',
    DOGEUSDT: '0.000010',
    ADAUSDT: '0.00010',
    AVAXUSDT: '0.010',
  };

  const EXPECTED: Record<string, number> = {
    BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 2, BNBUSDT: 2,
    XRPUSDT: 4, DOGEUSDT: 5, ADAUSDT: 4, AVAXUSDT: 2,
  };

  for (const [pair, tickSize] of Object.entries(PAIR_TICK_SIZES)) {
    it(`${pair} tickSize=${tickSize} → ${EXPECTED[pair]}dp`, () => {
      expect(computeDecimalsFromStep(tickSize)).toBe(EXPECTED[pair]);
    });
  }
});

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
      submitNewAlgoOrder: vi.fn().mockResolvedValue({
        algoId: 'algo_789',
        success: true,
      }),
      cancelAllAlgoOpenOrders: vi.fn().mockResolvedValue({ code: '000000' }),
      getSymbolPriceTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', price: '50000.00' }),
      getPositions: vi.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', positionAmt: '0.001' },
      ]),
    };
    executor = new OrderExecutor(mockClient);
  });

  it('opens a LONG position with market order + algo stop-loss + algo take-profit', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);

    expect(mockClient.setLeverage).toHaveBeenCalledWith({ symbol: 'BTCUSDT', leverage: 10 });
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1); // entry only
    expect(mockClient.submitNewAlgoOrder).toHaveBeenCalledTimes(2); // SL + TP
    expect(result.success).toBe(true);

    const stopCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
    expect(stopCall.algoType).toBe('CONDITIONAL');
    expect(stopCall.type).toBe('STOP_MARKET');
    expect(stopCall.triggerPrice).toBeDefined();
    expect(stopCall.closePosition).toBe('true');

    const tpCall = mockClient.submitNewAlgoOrder.mock.calls[1][0];
    expect(tpCall.algoType).toBe('CONDITIONAL');
    expect(tpCall.type).toBe('TAKE_PROFIT_MARKET');
    expect(tpCall.triggerPrice).toBeDefined();
    expect(tpCall.closePosition).toBe('true');
  });

  it('stop price is below entry for LONG, above for SHORT', async () => {
    const longDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    await executor.execute(longDecision, 10);
    const stopCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
    expect(parseFloat(stopCall.triggerPrice)).toBeLessThan(50000);

    mockClient.submitNewAlgoOrder.mockClear();

    const shortDecision: TradeDecision = {
      pair: 'BTCUSDT', action: 'SHORT', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    await executor.execute(shortDecision, 10);
    const shortStopCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
    expect(parseFloat(shortStopCall.triggerPrice)).toBeGreaterThan(50000);
  });

  it('take-profit price is above entry for LONG', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    await executor.execute(decision, 10);
    const tpCall = mockClient.submitNewAlgoOrder.mock.calls[1][0];
    expect(parseFloat(tpCall.triggerPrice)).toBeGreaterThan(50000);
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

  it('closes a position and cancels algo orders', async () => {
    const result = await executor.close('BTCUSDT', 'LONG');
    expect(mockClient.cancelAllAlgoOpenOrders).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
    expect(mockClient.getPositions).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1);
    const call = mockClient.submitNewOrder.mock.calls[0][0];
    expect(call.reduceOnly).toBe('true');
    expect(result.success).toBe(true);
  });

  it('close succeeds even if cancelAllAlgoOpenOrders fails', async () => {
    mockClient.cancelAllAlgoOpenOrders.mockRejectedValue(new Error('No algo orders'));

    const result = await executor.close('BTCUSDT', 'LONG');
    expect(result.success).toBe(true);
  });

  it('closes position if SL algo placement fails', async () => {
    mockClient.submitNewAlgoOrder = vi.fn().mockRejectedValueOnce(new Error('SL rejected'));
    mockClient.getPositions = vi.fn().mockResolvedValue([
      { symbol: 'BTCUSDT', positionAmt: '0.001' },
    ]);

    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('SL');
    // entry (submitNewOrder) + close (submitNewOrder) = 2
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(2);
    // SL attempt (submitNewAlgoOrder) = 1
    expect(mockClient.submitNewAlgoOrder).toHaveBeenCalledTimes(1);
  });

  it('succeeds if only TP fails (SL is set)', async () => {
    mockClient.submitNewAlgoOrder = vi.fn()
      .mockResolvedValueOnce({ algoId: 'sl_ok' }) // SL OK
      .mockRejectedValueOnce(new Error('TP rejected')); // TP fails

    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10000);

    expect(result.success).toBe(true); // TP failure is non-fatal
  });

  it('execute returns fillPrice, slPrice, tpPrice on success', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG' as const, size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test', confidence: 80,
    };

    mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '70000' });
    mockClient.setLeverage.mockResolvedValue({});
    mockClient.submitNewOrder.mockResolvedValue({
      orderId: 123,
      fills: [{ price: '70000', qty: '0.01' }],
    });
    mockClient.submitNewAlgoOrder.mockResolvedValue({});

    const result = await executor.execute(decision, 1000);

    expect(result.success).toBe(true);
    expect(result.fillPrice).toBeCloseTo(70000);
    expect(result.slPrice).toBeCloseTo(70000 * 0.98);
    expect(result.tpPrice).toBeCloseTo(70000 * 1.05);
    expect(result.quantity).toBeGreaterThan(0);
  });

  it('rounds quantity to pair stepSize (ADA stepSize=1 → integer)', async () => {
    mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '0.27' });
    mockClient.submitNewOrder.mockResolvedValue({ orderId: 999, fills: [{ price: '0.27', qty: '155' }] });
    mockClient.submitNewAlgoOrder.mockResolvedValue({});

    const executor2 = new OrderExecutor(mockClient, new Map([['ADAUSDT', 0]]));
    const decision: TradeDecision = {
      pair: 'ADAUSDT', action: 'SHORT', size_pct: 12,
      leverage: 5, stop_loss_pct: 2.2, take_profit_pct: 5.8, reasoning: 'test',
    };

    const result = await executor2.execute(decision, 178);
    const qty = parseFloat(mockClient.submitNewOrder.mock.calls[0][0].quantity);
    expect(qty).toBe(Math.floor(qty)); // must be integer for ADA
    expect(result.success).toBe(true);
  });

  it('falls back to hardcoded precision if stepSize map empty', async () => {
    const executor2 = new OrderExecutor(mockClient);
    const decision: TradeDecision = {
      pair: 'SOLUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
    };

    const result = await executor2.execute(decision, 100);
    expect(result.success).toBe(true);
  });

  describe('adjustSlTp', () => {
    it('cancels old algo orders and places new SL/TP', async () => {
      const result = await executor.adjustSlTp({
        pair: 'ADAUSDT',
        side: 'SHORT',
        newSlPrice: 0.265,
        newTpPrice: 0.250,
      });

      expect(result.success).toBe(true);
      expect(mockClient.cancelAllAlgoOpenOrders).toHaveBeenCalledOnce();
      expect(mockClient.cancelAllAlgoOpenOrders).toHaveBeenCalledWith({ symbol: 'ADAUSDT' });
      expect(mockClient.submitNewAlgoOrder).toHaveBeenCalledTimes(2);

      const slCall = mockClient.submitNewAlgoOrder.mock.calls[0][0];
      expect(slCall.side).toBe('BUY'); // SHORT → close side is BUY
      expect(slCall.type).toBe('STOP_MARKET');
      expect(slCall.closePosition).toBe('true');

      const tpCall = mockClient.submitNewAlgoOrder.mock.calls[1][0];
      expect(tpCall.side).toBe('BUY');
      expect(tpCall.type).toBe('TAKE_PROFIT_MARKET');
      expect(tpCall.closePosition).toBe('true');

      expect(result.slPrice).toBe(0.265);
      expect(result.tpPrice).toBe(0.250);
    });

    it('returns failure if new SL placement fails', async () => {
      mockClient.submitNewAlgoOrder.mockRejectedValueOnce(new Error('SL rejected by exchange'));

      const result = await executor.adjustSlTp({
        pair: 'ADAUSDT',
        side: 'LONG',
        newSlPrice: 0.260,
        newTpPrice: 0.280,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Adjust SL failed');
    });
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

  describe('roundPrice per-pair precision', () => {
    it('rounds DOGEUSDT SL/TP to 5dp (tickSize 0.00001)', async () => {
      const priceDecimals = new Map([['DOGEUSDT', 5]]);
      const stepDecimals = new Map([['DOGEUSDT', 0]]);
      const exec = new OrderExecutor(mockClient, stepDecimals, priceDecimals);

      mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '0.17432' });
      mockClient.submitNewOrder.mockResolvedValue({
        orderId: 1, fills: [{ price: '0.17432', qty: '100' }],
      });
      mockClient.submitNewAlgoOrder.mockResolvedValue({});

      const decision: TradeDecision = {
        pair: 'DOGEUSDT', action: 'LONG', size_pct: 10,
        leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
      };

      await exec.execute(decision, 100);

      const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
      // 0.17432 * 0.98 = 0.1708336 → should round to 5dp: 0.17083
      expect(slPrice).toBe('0.17083');

      const tpPrice = mockClient.submitNewAlgoOrder.mock.calls[1][0].triggerPrice;
      // 0.17432 * 1.05 = 0.183036 → should round to 5dp: 0.18304
      expect(tpPrice).toBe('0.18304');
    });

    it('rounds ADAUSDT SL/TP to 4dp (tickSize 0.0001)', async () => {
      const priceDecimals = new Map([['ADAUSDT', 4]]);
      const stepDecimals = new Map([['ADAUSDT', 0]]);
      const exec = new OrderExecutor(mockClient, stepDecimals, priceDecimals);

      mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '0.7523' });
      mockClient.submitNewOrder.mockResolvedValue({
        orderId: 1, fills: [{ price: '0.7523', qty: '50' }],
      });
      mockClient.submitNewAlgoOrder.mockResolvedValue({});

      const decision: TradeDecision = {
        pair: 'ADAUSDT', action: 'SHORT', size_pct: 10,
        leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
      };

      await exec.execute(decision, 100);

      const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
      // SHORT SL: 0.7523 * 1.02 = 0.767346 → 4dp: 0.7673
      expect(slPrice).toBe('0.7673');

      const tpPrice = mockClient.submitNewAlgoOrder.mock.calls[1][0].triggerPrice;
      // SHORT TP: 0.7523 * 0.95 = 0.714685 → 4dp: 0.7147
      expect(tpPrice).toBe('0.7147');
    });

    it('falls back to 2dp when pair not in priceDecimals map', async () => {
      const priceDecimals = new Map<string, number>(); // empty
      const exec = new OrderExecutor(mockClient, new Map(), priceDecimals);

      mockClient.getSymbolPriceTicker.mockResolvedValue({ price: '50000' });
      mockClient.submitNewOrder.mockResolvedValue({
        orderId: 1, fills: [{ price: '50000', qty: '0.001' }],
      });
      mockClient.submitNewAlgoOrder.mockResolvedValue({});

      const decision: TradeDecision = {
        pair: 'BTCUSDT', action: 'LONG', size_pct: 10,
        leverage: 5, stop_loss_pct: 2, take_profit_pct: 5, reasoning: 'test',
      };

      await exec.execute(decision, 1000);

      const slPrice = mockClient.submitNewAlgoOrder.mock.calls[0][0].triggerPrice;
      // 50000 * 0.98 = 49000 → 2dp fallback: "49000.00"
      expect(slPrice).toBe('49000.00');
    });
  });
});
