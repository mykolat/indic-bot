import { describe, it, expect, vi } from 'vitest';
import { StrategicSession } from '../../src/sessions/strategic-session.js';
import type { SessionDeps, MarketContext } from '../../src/sessions/types.js';

vi.mock('../../src/db/repository.js', () => ({
  insertDailyDirective: vi.fn().mockResolvedValue('directive-uuid'),
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

const defaultCtx: MarketContext = {
  regimes: { BTCUSDT: { regime: 'BullTrend', confidence: 0.8 } },
  fearGreed: { value: 55, label: 'Neutral' },
};

describe('StrategicSession', () => {
  it('returns a valid directive with default values when LLM returns empty JSON', async () => {
    const deps = makeDeps();
    const session = new StrategicSession(deps);
    const directive = await session.run(defaultCtx);

    expect(directive.allowed_pairs).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(directive.risk_appetite).toBe('normal');
    expect(directive.max_exposure_pct).toBe(150);
    expect(directive.banned_pairs).toEqual([]);
    expect(directive.session_id).toBe('session-1');
    expect(directive.valid_until).toBeDefined();
  });

  it('aggregates strategist output into directive', async () => {
    const deps = makeDeps({
      llm: {
        call: vi.fn()
          .mockResolvedValueOnce(JSON.stringify({
            allowed_pairs: ['BTCUSDT'],
            pair_bias: { BTCUSDT: 'bullish' },
            key_levels: { BTCUSDT: { support: [95000], resistance: [105000] } },
            reasoning: 'BTC trend is strong',
          }))
          .mockResolvedValueOnce(JSON.stringify({
            risk_appetite: 'aggressive',
            max_exposure_pct: 200,
            banned_pairs: ['DOGEUSDT'],
          })),
      },
    });
    const session = new StrategicSession(deps);
    const directive = await session.run(defaultCtx);

    expect(directive.allowed_pairs).toEqual(['BTCUSDT']);
    expect(directive.pair_bias).toEqual({ BTCUSDT: 'bullish' });
    expect(directive.risk_appetite).toBe('aggressive');
    expect(directive.max_exposure_pct).toBe(200);
    expect(directive.banned_pairs).toEqual(['DOGEUSDT']);
    expect(directive.reasoning).toContain('BTC trend');
  });

  it('downgrades to conservative when grok detects fear events', async () => {
    const deps = makeDeps({
      llm: { call: vi.fn().mockResolvedValue('{}') },
      grok: {
        call: vi.fn().mockResolvedValue(JSON.stringify({
          mood: 'fearful',
          fear_events: ['SEC lawsuit', 'Exchange hack'],
          narratives: [],
          unusual: [],
          reasoning: 'Multiple fear catalysts',
        })),
      },
    });
    const session = new StrategicSession(deps);
    const directive = await session.run(defaultCtx);

    expect(directive.risk_appetite).toBe('conservative');
    expect(directive.reasoning).toContain('Grok sentinel');
    expect(directive.reasoning).toContain('SEC lawsuit');
  });

  it('handles LLM failures gracefully (returns defaults)', async () => {
    const deps = makeDeps({
      llm: { call: vi.fn().mockRejectedValue(new Error('LLM down')) },
    });
    const session = new StrategicSession(deps);
    const directive = await session.run(defaultCtx);

    expect(directive.allowed_pairs).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(directive.risk_appetite).toBe('normal');
  });

  it('calls LLM experts in parallel', async () => {
    const callFn = vi.fn().mockResolvedValue('{}');
    const deps = makeDeps({ llm: { call: callFn } });
    const session = new StrategicSession(deps);
    await session.run(defaultCtx);

    // strategist + risk_assessor = 2 calls (no grok)
    expect(callFn).toHaveBeenCalledTimes(2);
  });
});
