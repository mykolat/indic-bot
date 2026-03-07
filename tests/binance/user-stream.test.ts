import { describe, it, expect } from 'vitest';
import { parseOrderUpdate, isSlTpFill } from '../../src/binance/user-stream.js';

describe('parseOrderUpdate', () => {
  it('extracts fields from ORDER_TRADE_UPDATE', () => {
    const event = {
      e: 'ORDER_TRADE_UPDATE',
      o: {
        s: 'BTCUSDT',
        S: 'SELL',
        o: 'STOP_MARKET',
        X: 'FILLED',
        ap: '65000.5',
        rp: '12.34',
        cp: true,
        T: 1709827200000,
      },
    };
    const parsed = parseOrderUpdate(event);
    expect(parsed).toEqual({
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP_MARKET',
      status: 'FILLED',
      avgPrice: 65000.5,
      realizedPnl: 12.34,
      closePosition: true,
      tradeTime: 1709827200000,
    });
  });
});

describe('isSlTpFill', () => {
  it('identifies SL fill', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'FILLED', closePosition: true })).toBe(true);
  });

  it('identifies TP fill', () => {
    expect(isSlTpFill({ orderType: 'TAKE_PROFIT_MARKET', status: 'FILLED', closePosition: true })).toBe(true);
  });

  it('rejects regular market order', () => {
    expect(isSlTpFill({ orderType: 'MARKET', status: 'FILLED', closePosition: false })).toBe(false);
  });

  it('rejects non-filled SL', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'NEW', closePosition: true })).toBe(false);
  });

  it('rejects non-closePosition SL', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'FILLED', closePosition: false })).toBe(false);
  });
});
