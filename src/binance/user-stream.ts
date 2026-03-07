import type { USDMClient } from 'binance';
import WebSocket from 'ws';
import { findOpenExecutionByPair, insertTradeClose } from '../db/repository.js';

export interface OrderUpdateParsed {
  symbol: string;
  side: string;
  orderType: string;
  status: string;
  avgPrice: number;
  realizedPnl: number;
  closePosition: boolean;
  tradeTime: number;
}

export function parseOrderUpdate(event: any): OrderUpdateParsed {
  const o = event.o;
  return {
    symbol: o.s,
    side: o.S,
    orderType: o.o,
    status: o.X,
    avgPrice: parseFloat(o.ap),
    realizedPnl: parseFloat(o.rp),
    closePosition: !!o.cp,
    tradeTime: o.T,
  };
}

export function isSlTpFill(parsed: Partial<OrderUpdateParsed>): boolean {
  return (
    (parsed.orderType === 'STOP_MARKET' || parsed.orderType === 'TAKE_PROFIT_MARKET') &&
    parsed.status === 'FILLED' &&
    parsed.closePosition === true
  );
}

async function handleSlTpFill(update: OrderUpdateParsed): Promise<void> {
  // SL/TP close side is opposite of position side
  const posSide = update.side === 'SELL' ? 'BUY' : 'SELL';
  const exec = await findOpenExecutionByPair(update.symbol, posSide);
  if (!exec) {
    console.log(`[UserStream] No open execution found for ${update.symbol} ${posSide}`);
    return;
  }
  const entryPrice = parseFloat(exec.fill_price);
  const pnlPct = posSide === 'BUY'
    ? ((update.avgPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - update.avgPrice) / entryPrice) * 100;
  const heldMs = update.tradeTime - new Date(exec.opened_at).getTime();

  await insertTradeClose({
    execution_id: exec.id,
    pair: update.symbol,
    exit_price: update.avgPrice,
    exit_reason: update.orderType === 'STOP_MARKET' ? 'sl_triggered' : 'tp_triggered',
    pnl_usd: update.realizedPnl,
    pnl_pct: pnlPct,
    held_hours: heldMs / 3600000,
    holding_time_minutes: heldMs / 60000,
  });
  console.log(`[UserStream] trade_closes inserted for ${update.symbol} exec #${exec.id} | ${update.orderType} @ ${update.avgPrice} | PnL $${update.realizedPnl.toFixed(4)}`);
}

/**
 * Start Binance User Data Stream via WebSocket.
 * Listens for ORDER_TRADE_UPDATE and writes trade_closes when SL/TP fires.
 */
export async function startUserStream(client: USDMClient): Promise<{ stop: () => void }> {
  let currentListenKey = (await client.getFuturesUserDataListenKey()).listenKey;

  let consecutiveKeepaliveFailures = 0;
  let lastMessageAt = Date.now();
  let ws: WebSocket;
  let stopped = false;

  function getWsUrl() {
    return `wss://fstream.binance.com/ws/${currentListenKey}`;
  }

  async function refreshListenKey(): Promise<void> {
    try {
      const result = await client.getFuturesUserDataListenKey();
      currentListenKey = result.listenKey;
      consecutiveKeepaliveFailures = 0;
      console.log('[UserStream] Listen key refreshed');
    } catch (err: any) {
      console.error('[UserStream] Listen key refresh failed:', err.message);
    }
  }

  const keepAlive = setInterval(async () => {
    try {
      await client.keepAliveFuturesUserDataListenKey();
      consecutiveKeepaliveFailures = 0;
    } catch (err: any) {
      consecutiveKeepaliveFailures++;
      console.error(`[UserStream] Keep-alive failed (${consecutiveKeepaliveFailures}x):`, err.message);
      if (consecutiveKeepaliveFailures >= 2) {
        console.log('[UserStream] 2 consecutive keepalive failures — refreshing listen key + reconnect');
        await refreshListenKey();
        ws.close(); // triggers reconnect via on('close')
      }
    }
  }, 30 * 60 * 1000);

  // Stale connection detector — if no message in 90 min, force reconnect
  const staleCheck = setInterval(() => {
    if (stopped) return;
    const silenceMs = Date.now() - lastMessageAt;
    if (silenceMs > 90 * 60 * 1000) {
      console.log(`[UserStream] No message for ${Math.round(silenceMs / 60000)}min — forcing reconnect`);
      ws.close(); // triggers reconnect via on('close')
    }
  }, 15 * 60 * 1000);

  function connect() {
    ws = new WebSocket(getWsUrl());
    lastMessageAt = Date.now();

    ws.on('message', async (data: any) => {
      lastMessageAt = Date.now();
      try {
        const event = JSON.parse(data.toString());
        if (event.e !== 'ORDER_TRADE_UPDATE') return;
        const parsed = parseOrderUpdate(event);
        if (isSlTpFill(parsed)) {
          console.log(`[UserStream] SL/TP filled: ${parsed.symbol} ${parsed.orderType} @ ${parsed.avgPrice}`);
          await handleSlTpFill(parsed);
        }
      } catch (err: any) {
        console.error('[UserStream] Error:', err.message);
      }
    });

    ws.on('error', (err) => console.error('[UserStream] WS error:', err.message));

    ws.on('close', () => {
      if (stopped) return;
      console.log('[UserStream] WS closed — reconnecting in 5s');
      setTimeout(connect, 5000);
    });
  }

  connect();
  console.log('[UserStream] Connected to Binance User Data Stream');

  return {
    stop: () => {
      stopped = true;
      clearInterval(keepAlive);
      clearInterval(staleCheck);
      ws.close();
    },
  };
}
