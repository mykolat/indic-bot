import { describe, it, expect } from 'vitest';
import {
  SwarmBlackboard,
  type BlackboardMarket,
  type PersonaUpdate,
} from '../../src/llm/swarm-blackboard.js';

const makeMarket = (): BlackboardMarket => ({
  pairs: ['BTCUSDT', 'ETHUSDT'],
  regime: 'Range',
  fearGreed: 55,
  volumeRatio: 1.2,
  keyLevels: ['BTC 68k support'],
});

const makeBullUpdate = (overrides?: Partial<PersonaUpdate>): PersonaUpdate => ({
  signals: {
    bullish: ['RSI oversold bounce', 'Volume surge'],
    bearish: [],
    neutral: [],
  },
  vote: { d: 'LONG', c: 75, prob: 70, reason: 'bull_breakout' },
  risks: ['false breakout risk'],
  conflicts_with: {},
  ...overrides,
});

const makeBearUpdate = (overrides?: Partial<PersonaUpdate>): PersonaUpdate => ({
  signals: {
    bullish: [],
    bearish: ['Death cross forming', 'Funding rate elevated'],
    neutral: [],
  },
  vote: { d: 'SHORT', c: 80, prob: 65, reason: 'bear_continuation' },
  risks: ['short squeeze risk'],
  conflicts_with: {},
  ...overrides,
});

describe('SwarmBlackboard', () => {
  it('initializes with market data and empty signals/votes/conflicts', () => {
    const market = makeMarket();
    const bb = new SwarmBlackboard(market);
    const state = bb.getState();

    expect(state.market).toEqual(market);
    expect(state.signals).toEqual({ bullish: [], bearish: [], neutral: [] });
    expect(state.votes).toEqual({});
    expect(state.risks).toEqual([]);
    expect(state.conflicts).toEqual([]);
  });

  it('merges persona update — signals, vote, and risks', () => {
    const bb = new SwarmBlackboard(makeMarket());
    const update = makeBullUpdate();

    bb.mergePersonaUpdate('BT', update);
    const state = bb.getState();

    expect(state.signals.bullish).toEqual(['RSI oversold bounce', 'Volume surge']);
    expect(state.votes['BT']).toEqual({ d: 'LONG', c: 75, prob: 70, reason: 'bull_breakout' });
    expect(state.risks).toContain('false breakout risk');
  });

  it('deduplicates signals across personas', () => {
    const bb = new SwarmBlackboard(makeMarket());

    // Both personas report the same bullish signal
    bb.mergePersonaUpdate('BT', makeBullUpdate({
      signals: { bullish: ['RSI oversold bounce'], bearish: [], neutral: ['sideways chop'] },
    }));
    bb.mergePersonaUpdate('MS', makeBullUpdate({
      signals: { bullish: ['RSI oversold bounce', 'OI rising'], bearish: [], neutral: ['sideways chop'] },
    }));

    const state = bb.getState();
    expect(state.signals.bullish).toEqual(['RSI oversold bounce', 'OI rising']);
    expect(state.signals.neutral).toEqual(['sideways chop']);
  });

  it('deduplicates risks across personas', () => {
    const bb = new SwarmBlackboard(makeMarket());

    bb.mergePersonaUpdate('BT', makeBullUpdate({ risks: ['false breakout risk', 'low liquidity'] }));
    bb.mergePersonaUpdate('MS', makeBullUpdate({ risks: ['false breakout risk', 'whale dump'] }));

    const state = bb.getState();
    expect(state.risks).toEqual(['false breakout risk', 'low liquidity', 'whale dump']);
  });

  it('detects high severity conflict — LONG vs SHORT, both confidence >= 60', () => {
    const bb = new SwarmBlackboard(makeMarket());

    bb.mergePersonaUpdate('BT', makeBullUpdate({
      vote: { d: 'LONG', c: 75, prob: 70, reason: 'bull_breakout' },
    }));
    bb.mergePersonaUpdate('BE', makeBearUpdate({
      vote: { d: 'SHORT', c: 80, prob: 65, reason: 'bear_continuation' },
      conflicts_with: { BT: 'direction_disagreement' },
    }));

    const state = bb.getState();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toEqual({
      between: ['BE', 'BT'],
      topic: 'direction_disagreement',
      severity: 'high',
    });
  });

  it('detects medium severity conflict — LONG vs SHORT, one confidence < 60', () => {
    const bb = new SwarmBlackboard(makeMarket());

    bb.mergePersonaUpdate('BT', makeBullUpdate({
      vote: { d: 'LONG', c: 45, prob: 50, reason: 'weak_bull' },
    }));
    bb.mergePersonaUpdate('BE', makeBearUpdate({
      vote: { d: 'SHORT', c: 80, prob: 65, reason: 'bear_continuation' },
      conflicts_with: { BT: 'direction_disagreement' },
    }));

    const state = bb.getState();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].severity).toBe('medium');
  });

  it('detects low severity conflict — same direction disagreement', () => {
    const bb = new SwarmBlackboard(makeMarket());

    bb.mergePersonaUpdate('BT', makeBullUpdate({
      vote: { d: 'LONG', c: 80, prob: 70, reason: 'breakout' },
    }));
    bb.mergePersonaUpdate('MS', makeBullUpdate({
      vote: { d: 'LONG', c: 50, prob: 40, reason: 'uncertain_support' },
      conflicts_with: { BT: 'confidence_gap' },
    }));

    const state = bb.getState();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].severity).toBe('low');
  });

  it('skips conflict if opposing persona has no vote yet', () => {
    const bb = new SwarmBlackboard(makeMarket());

    bb.mergePersonaUpdate('BT', makeBullUpdate({
      conflicts_with: { BE: 'predicted_disagreement' },
    }));

    const state = bb.getState();
    expect(state.conflicts).toHaveLength(0);
  });

  it('getConflictingSpeakers returns only medium/high conflict personas', () => {
    const bb = new SwarmBlackboard(makeMarket());

    // Low severity conflict
    bb.mergePersonaUpdate('BT', makeBullUpdate({
      vote: { d: 'LONG', c: 80, prob: 70, reason: 'breakout' },
    }));
    bb.mergePersonaUpdate('MS', makeBullUpdate({
      vote: { d: 'LONG', c: 50, prob: 40, reason: 'uncertain' },
      conflicts_with: { BT: 'confidence_gap' },
    }));

    // High severity conflict
    bb.mergePersonaUpdate('BE', makeBearUpdate({
      vote: { d: 'SHORT', c: 80, prob: 65, reason: 'bear' },
      conflicts_with: { BT: 'direction' },
    }));

    const speakers = bb.getConflictingSpeakers();
    // Should include BE and BT (high), but NOT MS (only in low conflict)
    expect(speakers).toContain('BE');
    expect(speakers).toContain('BT');
    expect(speakers).not.toContain('MS');
  });

  it('toJSON returns valid serializable string', () => {
    const bb = new SwarmBlackboard(makeMarket());
    bb.mergePersonaUpdate('BT', makeBullUpdate());
    bb.mergePersonaUpdate('BE', makeBearUpdate({
      conflicts_with: { BT: 'direction' },
    }));

    const json = bb.toJSON();
    expect(typeof json).toBe('string');

    const parsed = JSON.parse(json);
    expect(parsed.market.pairs).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(parsed.votes.BT.d).toBe('LONG');
    expect(parsed.votes.BE.d).toBe('SHORT');
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.risks).toContain('false breakout risk');
    expect(parsed.risks).toContain('short squeeze risk');
  });

  it('getState returns a deep clone — mutations do not affect blackboard', () => {
    const bb = new SwarmBlackboard(makeMarket());
    bb.mergePersonaUpdate('BT', makeBullUpdate());

    const state = bb.getState();
    state.signals.bullish.push('INJECTED');
    state.votes['BT'].c = 0;
    state.risks.push('INJECTED_RISK');

    const fresh = bb.getState();
    expect(fresh.signals.bullish).not.toContain('INJECTED');
    expect(fresh.votes['BT'].c).toBe(75);
    expect(fresh.risks).not.toContain('INJECTED_RISK');
  });
});
