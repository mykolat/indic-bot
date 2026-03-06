import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createWebhookServer } from '../../src/webhook/server.js';

describe('/api/status endpoint', () => {
  const mockSignalBuffer = { add: vi.fn(), drain: vi.fn() } as any;
  const mockLogger = { logDecision: vi.fn(), logError: vi.fn() } as any;

  it('returns full account status', async () => {
    const mockMarketData = {
      getPortfolioState: vi.fn().mockResolvedValue({
        balanceUsd: 1000,
        availableUsd: 800,
        marginBalanceUsd: 1050,
        totalUnrealizedPnlUsd: 25,
        bnbBalance: 0.5,
        totalAccountValueUsd: 1350,
        positions: [
          {
            pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 10,
            entryPrice: 50000, marginUsd: 50, unrealizedPnlUsd: 25,
            unrealizedPnlPct: 50, heldHours: 2.5,
          },
        ],
        sessionPnl: 0,
        drawdownPct: 0,
      }),
      getTodayRealizedPnl: vi.fn().mockResolvedValue(42.5),
    };

    const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, mockMarketData);
    const res = await request(app).get('/api/status');

    expect(res.status).toBe(200);
    expect(res.body.balance.usdt).toBe(1000);
    expect(res.body.balance.available).toBe(800);
    expect(res.body.balance.margin).toBe(1050);
    expect(res.body.balance.bnb).toBe(0.5);
    expect(res.body.balance.totalAccountValue).toBe(1350);
    expect(res.body.balance.totalUnrealizedPnl).toBe(25);
    expect(res.body.balance.todayRealizedPnl).toBe(42.5);
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.positions[0].pair).toBe('BTCUSDT');
    expect(res.body.positions[0].marginUsd).toBe(50);
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns 500 on error', async () => {
    const mockMarketData = {
      getPortfolioState: vi.fn().mockRejectedValue(new Error('Binance down')),
      getTodayRealizedPnl: vi.fn().mockResolvedValue(0),
    };

    const app = createWebhookServer(mockSignalBuffer, mockLogger, undefined, mockMarketData);
    const res = await request(app).get('/api/status');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Binance down');
  });

  it('no /api/status when marketData not provided', async () => {
    const app = createWebhookServer(mockSignalBuffer, mockLogger);
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(404);
  });
});
