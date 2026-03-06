import express from 'express';
import type { SignalBuffer, TradingViewSignal } from './signal-buffer.js';
import type { Logger } from '../logger/index.js';
import { insertWebhookSignal } from '../db/repository.js';

export function createWebhookServer(
  signalBuffer: SignalBuffer,
  logger: Logger,
  secret?: string,
  marketData?: any,
): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    if (secret && req.headers['x-webhook-secret'] !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { signal, pair, indicator, value, timeframe } = req.body;

    if (!signal || !pair) {
      res.status(400).json({ error: 'Missing signal or pair' });
      return;
    }

    const tvSignal: TradingViewSignal = {
      signal,
      pair,
      indicator: indicator || 'unknown',
      value: value || 0,
      timeframe: timeframe || '1h',
    };

    signalBuffer.add(tvSignal);
    insertWebhookSignal({
      pair: tvSignal.pair || 'UNKNOWN',
      action: tvSignal.signal,
      source: 'tradingview',
      payload: tvSignal,
    }).catch(() => {});
    logger.logDecision({ type: 'WEBHOOK_RECEIVED', ...tvSignal });

    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  if (marketData) {
    app.get('/api/status', async (_req, res) => {
      try {
        const [portfolio, todayPnl] = await Promise.all([
          marketData.getPortfolioState(),
          marketData.getTodayRealizedPnl(),
        ]);
        res.json({
          balance: {
            usdt: portfolio.balanceUsd,
            available: portfolio.availableUsd,
            margin: portfolio.marginBalanceUsd,
            bnb: portfolio.bnbBalance,
            totalAccountValue: portfolio.totalAccountValueUsd,
            totalUnrealizedPnl: portfolio.totalUnrealizedPnlUsd,
            todayRealizedPnl: todayPnl,
          },
          positions: portfolio.positions.map((p: any) => ({
            pair: p.pair,
            side: p.side,
            sizeUsd: p.sizeUsd,
            leverage: p.leverage,
            entryPrice: p.entryPrice,
            marginUsd: p.marginUsd,
            unrealizedPnlUsd: p.unrealizedPnlUsd,
            unrealizedPnlPct: p.unrealizedPnlPct,
            heldHours: p.heldHours,
          })),
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  return app;
}
