import { describe, it, expect, vi } from 'vitest';
import { TacticalSession } from '../../src/sessions/tactical-session.js';
import type { SessionDeps, MarketContext, DailyDirective } from '../../src/sessions/types.js';

vi.mock('../../src/db/repository.js', () => ({
  insertHourlyPlan: vi.fn().mockResolvedValue('plan-uuid'),
  insertExpertCall: vi.fn().mockResolvedValue(1),
}));

function makeDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  return {
    llm: { call: vi.fn().mockResolvedValue('{}') },
    sessionId: 'session-1',
    pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    ...overrides,
  };
}

const defaultDirective: DailyDirective = {
  id: 'dir-1',
  allowed_pairs: ['BTCUSDT', 'ETHUSDT'],
  pair_bias: { BTCUSDT: 'bullish' },
  max_exposure_pct: 150,
  risk_appetite: 'normal',
  banned_pairs: ['DOGEUSDT'],
  key_levels: {},
  reasoning: 'test',
};

const defaultCtx: MarketContext = {
  regimes: { BTCUSDT: { regime: 'BullTrend', confidence: 0.8 } },
  fearGreed: { value: 55, label: 'Neutral' },
};

describe('TacticalSession', () => {
  it('returns valid plan with defaults when LLM returns empty', async () => {
    const deps = makeDeps();
    const session = new TacticalSession(deps);
    const plan = await session.run(defaultDirective, defaultCtx);

    expect(plan.watchlist).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(plan.escalate_daily).toBe(false);
    expect(plan.directive_id).toBe('dir-1');
    expect(plan.session_id).toBe('session-1');
  });

  it('aggregates analyst output into plan', async () => {
    const deps = makeDeps({
      llm: {
        call: vi.fn().mockResolvedValue(JSON.stringify({
          watchlist: ['BTCUSDT'],
          entry_zones: { BTCUSDT: { min: 95000, max: 98000, bias: 'long' } },
          position_notes: { BTCUSDT: 'Strong support at 95K' },
          escalate_daily: false,
          reasoning: 'BTC consolidation',
        })),
      },
    });
    const session = new TacticalSession(deps);
    const plan = await session.run(defaultDirective, defaultCtx);

    expect(plan.watchlist).toEqual(['BTCUSDT']);
    expect(plan.entry_zones.BTCUSDT).toEqual({ min: 95000, max: 98000, bias: 'long' });
    expect(plan.position_notes.BTCUSDT).toBe('Strong support at 95K');
    expect(plan.reasoning).toContain('BTC consolidation');
  });

  it('sets escalate_daily when challenger finds hidden risks', async () => {
    const deps = makeDeps({
      llm: { call: vi.fn().mockResolvedValue('{}') },
      grok: {
        call: vi.fn().mockResolvedValue(JSON.stringify({
          hidden_risks: ['Whale accumulation pattern'],
          opportunities: [],
          escalate_daily: true,
          reasoning: 'Unusual whale activity',
        })),
      },
    });
    const session = new TacticalSession(deps);
    const plan = await session.run(defaultDirective, defaultCtx);

    expect(plan.escalate_daily).toBe(true);
    expect(plan.reasoning).toContain('Challenger risks');
    expect(plan.reasoning).toContain('Whale accumulation');
  });

  it('filters banned pairs from default watchlist', async () => {
    const directive: DailyDirective = {
      ...defaultDirective,
      allowed_pairs: ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT'],
      banned_pairs: ['DOGEUSDT'],
    };
    const deps = makeDeps();
    const session = new TacticalSession(deps);
    const plan = await session.run(directive, defaultCtx);

    expect(plan.watchlist).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(plan.watchlist).not.toContain('DOGEUSDT');
  });

  it('handles LLM failures gracefully', async () => {
    const deps = makeDeps({
      llm: { call: vi.fn().mockRejectedValue(new Error('LLM down')) },
    });
    const session = new TacticalSession(deps);
    const plan = await session.run(defaultDirective, defaultCtx);

    expect(plan.watchlist).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(plan.escalate_daily).toBe(false);
  });
});
