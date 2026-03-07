import { describe, it, expect } from 'vitest';
import { parseOrderUpdate, isSlTpFill } from '../../src/binance/user-stream.js';

describe('parseOrderUpdate', () => {
  it('parses Binance ORDER_TRADE_UPDATE event', () => {
    const event = {
      o: {
        s: 'BTCUSDT',
        S: 'SELL',
        o: 'STOP_MARKET',
        X: 'FILLED',
        ap: '50000.5',
        rp: '-12.34',
        cp: true,
        T: 1700000000000,
      },
    };
    const parsed = parseOrderUpdate(event);
    expect(parsed.symbol).toBe('BTCUSDT');
    expect(parsed.side).toBe('SELL');
    expect(parsed.orderType).toBe('STOP_MARKET');
    expect(parsed.status).toBe('FILLED');
    expect(parsed.avgPrice).toBeCloseTo(50000.5);
    expect(parsed.realizedPnl).toBeCloseTo(-12.34);
    expect(parsed.closePosition).toBe(true);
    expect(parsed.tradeTime).toBe(1700000000000);
  });
});

describe('isSlTpFill', () => {
  it('returns true for filled STOP_MARKET with closePosition', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'FILLED', closePosition: true })).toBe(true);
  });

  it('returns true for filled TAKE_PROFIT_MARKET with closePosition', () => {
    expect(isSlTpFill({ orderType: 'TAKE_PROFIT_MARKET', status: 'FILLED', closePosition: true })).toBe(true);
  });

  it('returns false for non-filled orders', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'NEW', closePosition: true })).toBe(false);
  });

  it('returns false for MARKET orders', () => {
    expect(isSlTpFill({ orderType: 'MARKET', status: 'FILLED', closePosition: true })).toBe(false);
  });

  it('returns false when closePosition is false', () => {
    expect(isSlTpFill({ orderType: 'STOP_MARKET', status: 'FILLED', closePosition: false })).toBe(false);
  });
});
