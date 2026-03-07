import WebSocket from 'ws';

export interface LiquidationEvent {
  pair: string;
  side: 'BUY' | 'SELL'; // BUY = short liq, SELL = long liq
  quantity: number;
  price: number;
  timestamp: number;
}

export interface LiquidationSnapshot {
  longLiquidations: number;
  shortLiquidations: number;
  longLiqUsd: number;
  shortLiqUsd: number;
  spikeRatio: number;
}

const ROLLING_WINDOW = 20;

export class LiquidationAggregator {
  private buffer = new Map<string, LiquidationEvent[]>();
  private history = new Map<string, number[]>();

  addEvent(event: LiquidationEvent): void {
    const buf = this.buffer.get(event.pair) ?? [];
    buf.push(event);
    this.buffer.set(event.pair, buf);
  }

  flush(pair: string): LiquidationSnapshot {
    const events = this.buffer.get(pair) ?? [];
    this.buffer.set(pair, []);

    let longLiquidations = 0, shortLiquidations = 0;
    let longLiqUsd = 0, shortLiqUsd = 0;

    for (const e of events) {
      const usd = e.quantity * e.price;
      if (e.side === 'SELL') { longLiquidations++; longLiqUsd += usd; }
      else { shortLiquidations++; shortLiqUsd += usd; }
    }

    const hist = this.history.get(pair) ?? [];
    const totalCount = longLiquidations + shortLiquidations;
    hist.push(totalCount);
    if (hist.length > ROLLING_WINDOW) hist.shift();
    this.history.set(pair, hist);

    const avg = hist.length > 1
      ? hist.slice(0, -1).reduce((a, b) => a + b, 0) / (hist.length - 1)
      : totalCount;
    const spikeRatio = avg > 0 ? totalCount / avg : 0;

    return { longLiquidations, shortLiquidations, longLiqUsd, shortLiqUsd, spikeRatio };
  }
}

export function startLiquidationFeed(
  pairs: string[],
  aggregator: LiquidationAggregator,
): WebSocket {
  const streams = pairs.map(p => `${p.toLowerCase()}@forceOrder`).join('/');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const order = msg.data?.o;
      if (!order) return;
      aggregator.addEvent({
        pair: order.s,
        side: order.S,
        quantity: parseFloat(order.q),
        price: parseFloat(order.p),
        timestamp: order.T,
      });
    } catch { /* ignore parse errors */ }
  });

  ws.on('error', (err) => console.error('[LiqFeed] WS error:', err.message));
  ws.on('close', () => {
    console.log('[LiqFeed] WS closed, reconnecting in 5s...');
    setTimeout(() => startLiquidationFeed(pairs, aggregator), 5000);
  });

  return ws;
}
