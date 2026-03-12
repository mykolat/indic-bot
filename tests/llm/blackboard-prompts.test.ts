import { describe, it, expect } from 'vitest';
import {
  BB_PERSONA_CODES,
  buildBlackboardExpertPrompt,
  buildBlackboardJudgePrompt,
  buildDAPrompt,
} from '../../src/llm/blackboard-prompts.js';
import type { BlackboardState } from '../../src/llm/swarm-blackboard.js';

const emptyBoard: BlackboardState = {
  market: { pairs: ['BTCUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.2 },
  signals: { bullish: [], bearish: [], neutral: [] },
  votes: {},
  risks: [],
  conflicts: [],
};

const boardWithVotes: BlackboardState = {
  market: { pairs: ['BTCUSDT', 'ETHUSDT'], regime: 'BullTrend', fearGreed: 72, volumeRatio: 1.8, keyLevels: ['BTC 100k resistance'] },
  signals: { bullish: ['EMA crossover'], bearish: ['RSI overbought'], neutral: [] },
  votes: {
    RM: { d: 'HOLD', c: 90, prob: 30, reason: 'high_leverage_risk' },
    BT: { d: 'LONG', c: 65, prob: 70, reason: 'momentum_breakout' },
  },
  risks: ['liquidation_cascade', 'low_liquidity'],
  conflicts: [
    { between: ['BT', 'RM'], topic: 'entry_timing', severity: 'high' },
  ],
};

describe('BB_PERSONA_CODES', () => {
  it('maps all six personas to correct short codes', () => {
    expect(BB_PERSONA_CODES).toEqual({
      risk_manager: 'RM',
      bull_thesis: 'BT',
      bear_thesis: 'BA',
      market_structure: 'MS',
      devils_advocate: 'DA',
      narrative_expert: 'NE',
    });
  });
});

describe('buildBlackboardExpertPrompt', () => {
  it('includes persona role, CODE, JSON output fields, and BLACKBOARD keyword', () => {
    const prompt = buildBlackboardExpertPrompt('risk_manager', emptyBoard);

    expect(prompt).toContain('ROLE: RISK MANAGER');
    expect(prompt).toContain('CODE: RM');
    expect(prompt).toContain('BLACKBOARD');
    expect(prompt).toContain('"signals"');
    expect(prompt).toContain('"vote"');
    expect(prompt).toContain('"conflicts_with"');
  });

  it('shows existing votes when boardState has votes (round 2+)', () => {
    const prompt = buildBlackboardExpertPrompt('bear_thesis', boardWithVotes);

    expect(prompt).toContain('CODE: BA');
    expect(prompt).toContain('BEAR ANALYST');
    // The serialized board should include existing votes from RM and BT
    expect(prompt).toContain('"RM"');
    expect(prompt).toContain('"BT"');
    expect(prompt).toContain('high_leverage_risk');
    expect(prompt).toContain('momentum_breakout');
    // Should also contain the existing signals and conflicts
    expect(prompt).toContain('EMA crossover');
    expect(prompt).toContain('entry_timing');
  });

  it('includes output format instructions with field guide', () => {
    const prompt = buildBlackboardExpertPrompt('devils_advocate', emptyBoard);

    expect(prompt).toContain('FIELD GUIDE:');
    expect(prompt).toContain('short tags');
    expect(prompt).toContain('raw JSON');
  });

  it('DA role description mentions profit and opportunity', () => {
    const prompt = buildBlackboardExpertPrompt('devils_advocate', emptyBoard);
    expect(prompt).toContain('PROFIT ADVOCATE');
    expect(prompt).toContain('opportunity');
  });
});

describe('buildBlackboardJudgePrompt', () => {
  it('includes continue, decisions, next_speakers, and BLACKBOARD keyword', () => {
    const prompt = buildBlackboardJudgePrompt(1, emptyBoard);

    expect(prompt).toContain('BLACKBOARD');
    expect(prompt).toContain('"continue"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"next_speakers"');
  });

  it('shows round number and max rounds', () => {
    const prompt = buildBlackboardJudgePrompt(2, boardWithVotes, 5);

    expect(prompt).toContain('Round 2/5');
  });

  it('includes vote summary with persona codes and values', () => {
    const prompt = buildBlackboardJudgePrompt(1, boardWithVotes);

    expect(prompt).toContain('VOTE SUMMARY:');
    expect(prompt).toContain('RM: HOLD (conf:90, prob:30)');
    expect(prompt).toContain('BT: LONG (conf:65, prob:70)');
  });

  it('includes conflict count with high severity breakdown', () => {
    const prompt = buildBlackboardJudgePrompt(1, boardWithVotes);

    expect(prompt).toContain('CONFLICT COUNT: 1 (high: 1)');
  });

  it('includes decision rules', () => {
    const prompt = buildBlackboardJudgePrompt(1, emptyBoard);

    expect(prompt).toContain('DECISION RULES:');
    expect(prompt).toContain('3+ same direction');
    expect(prompt).toContain('RM');
  });

  it('judge rules do not force HOLD when DA agrees with RM', () => {
    const prompt = buildBlackboardJudgePrompt(1, emptyBoard, 3);
    expect(prompt).not.toContain('DA agrees -> HOLD');
  });

  it('defaults maxRounds to 3 when not provided', () => {
    const prompt = buildBlackboardJudgePrompt(1, emptyBoard);

    expect(prompt).toContain('Round 1/3');
  });
});

describe('buildDAPrompt', () => {
  it('includes other votes and aggressive tone', () => {
    const boardState: BlackboardState = {
      market: { pairs: ['ETHUSDT'], regime: 'Range', fearGreed: 50, volumeRatio: 1.2 },
      signals: { bullish: ['ema_bounce'], bearish: [], neutral: [] },
      votes: {
        RM: { d: 'HOLD', c: 70, prob: 40, reason: 'too risky' },
        MS: { d: 'LONG', c: 65, prob: 55, reason: 'breakout forming' },
      },
      risks: ['liq_cascade'],
      conflicts: [],
    };

    const prompt = buildDAPrompt(boardState);
    expect(prompt).toContain('PROFIT ADVOCATE');
    expect(prompt).toContain('NEVER vote HOLD');
    expect(prompt).toContain('RM: HOLD');
    expect(prompt).toContain('MS: LONG');
    expect(prompt).toContain('ETHUSDT');
  });

  it('includes CLOSE counter-argument instruction when CLOSE vote exists', () => {
    const boardState: BlackboardState = {
      market: { pairs: ['BTCUSDT'], regime: 'BullTrend', fearGreed: 60, volumeRatio: 1.5 },
      signals: { bullish: [], bearish: ['breakdown'], neutral: [] },
      votes: {
        RM: { d: 'CLOSE', c: 80, prob: 30, reason: 'cut losses' },
        MS: { d: 'HOLD', c: 50, prob: 40, reason: 'unclear' },
      },
      risks: ['drawdown'],
      conflicts: [],
    };

    const prompt = buildDAPrompt(boardState);
    expect(prompt).toContain('CLOSE');
    expect(prompt).toContain('AGAINST closing');
  });
});
