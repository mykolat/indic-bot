import express from 'express';
import type { SignalBuffer, TradingViewSignal } from './signal-buffer.js';
import type { Logger } from '../logger/index.js';
import { insertWebhookSignal, insertSwarmPersona } from '../db/repository.js';

export function createWebhookServer(
  signalBuffer: SignalBuffer,
  logger: Logger,
  secret?: string,
  marketData?: any,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

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

  app.post('/api/swarm/inject', async (req, res) => {
    const { cycle_id, message } = req.body;
    if (!cycle_id || !message) {
      res.status(400).json({ error: 'Missing cycle_id or message' });
      return;
    }
    try {
      // Find latest conversation_id for this cycle
      const { getPool } = await import('../db/connection.js');
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id FROM llm_conversations WHERE cycle_id = $1 AND method = 'swarm_consensus' ORDER BY created_at DESC LIMIT 1`,
        [cycle_id],
      );
      const convId = rows[0]?.id ?? null;

      const id = await insertSwarmPersona({
        conversation_id: convId,
        persona: 'superuser',
        model: 'human',
        raw_response: message,
        reasoning: message,
        phase: 99, // superuser messages shown after current level
      });
      res.json({ ok: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
