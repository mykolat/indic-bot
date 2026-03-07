import { describe, it, expect } from 'vitest';
import { LiquidationAggregator } from '../../src/binance/liquidation-feed.js';

describe('LiquidationAggregator', () => {
  it('aggregates liquidation events into flush snapshot', () => {
    const agg = new LiquidationAggregator();
    agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.5, price: 70000, timestamp: Date.now() });
    agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.3, price: 69500, timestamp: Date.now() });
    agg.addEvent({ pair: 'BTCUSDT', side: 'BUY', quantity: 0.1, price: 71000, timestamp: Date.now() });

    const snap = agg.flush('BTCUSDT');
    expect(snap.longLiquidations).toBe(2);
    expect(snap.shortLiquidations).toBe(1);
    expect(snap.longLiqUsd).toBeCloseTo(0.5 * 70000 + 0.3 * 69500);
    expect(snap.shortLiqUsd).toBeCloseTo(0.1 * 71000);
  });

  it('returns zero snapshot when no events', () => {
    const agg = new LiquidationAggregator();
    const snap = agg.flush('BTCUSDT');
    expect(snap.longLiquidations).toBe(0);
    expect(snap.shortLiquidations).toBe(0);
    expect(snap.longLiqUsd).toBe(0);
    expect(snap.shortLiqUsd).toBe(0);
  });

  it('clears buffer after flush', () => {
    const agg = new LiquidationAggregator();
    agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 1, price: 70000, timestamp: Date.now() });
    agg.flush('BTCUSDT');
    const snap2 = agg.flush('BTCUSDT');
    expect(snap2.longLiquidations).toBe(0);
  });

  it('tracks pairs independently', () => {
    const agg = new LiquidationAggregator();
    agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 1, price: 70000, timestamp: Date.now() });
    agg.addEvent({ pair: 'ETHUSDT', side: 'BUY', quantity: 5, price: 3500, timestamp: Date.now() });

    const btc = agg.flush('BTCUSDT');
    const eth = agg.flush('ETHUSDT');
    expect(btc.longLiquidations).toBe(1);
    expect(eth.shortLiquidations).toBe(1);
  });

  it('detects spike when count exceeds rolling average', () => {
    const agg = new LiquidationAggregator();
    for (let i = 0; i < 10; i++) {
      agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.1, price: 70000, timestamp: Date.now() });
      agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.1, price: 70000, timestamp: Date.now() });
      agg.flush('BTCUSDT');
    }
    for (let i = 0; i < 15; i++) {
      agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.5, price: 70000, timestamp: Date.now() });
    }
    const snap = agg.flush('BTCUSDT');
    expect(snap.spikeRatio).toBeGreaterThan(5);
  });
});
