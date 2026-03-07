import { describe, it, expect } from 'vitest';
import { shouldActivateDA } from '../../src/llm/da-activation.js';
import type { BlackboardVote } from '../../src/llm/swarm-blackboard.js';

const vote = (d: string, c = 70, prob = 60): BlackboardVote => ({ d, c, prob, reason: 'test' });

describe('shouldActivateDA', () => {
  it('activates when exactly 1 action vote (LONG)', () => {
    const votes = { RM: vote('HOLD'), MS: vote('HOLD'), NE: vote('LONG') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('activates when exactly 1 action vote (SHORT)', () => {
    const votes = { RM: vote('HOLD'), MS: vote('SHORT'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('activates when CLOSE without action', () => {
    const votes = { RM: vote('CLOSE'), MS: vote('HOLD'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('activates when CLOSE + action', () => {
    const votes = { RM: vote('CLOSE'), MS: vote('LONG'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(true);
  });

  it('skips when all HOLD', () => {
    const votes = { RM: vote('HOLD'), MS: vote('HOLD'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(false);
  });

  it('skips when 2+ actions', () => {
    const votes = { RM: vote('LONG'), MS: vote('LONG'), NE: vote('HOLD') };
    expect(shouldActivateDA(votes)).toBe(false);
  });

  it('skips when empty votes', () => {
    expect(shouldActivateDA({})).toBe(false);
  });
});
