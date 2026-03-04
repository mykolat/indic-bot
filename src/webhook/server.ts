import express from 'express';
import type { SignalBuffer, TradingViewSignal } from './signal-buffer.js';
import type { Logger } from '../logger/index.js';

export function createWebhookServer(
  signalBuffer: SignalBuffer,
  logger: Logger,
  secret?: string,
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
    logger.logDecision({ type: 'WEBHOOK_RECEIVED', ...tvSignal });

    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
