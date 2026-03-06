import { describe, it, expect, vi } from 'vitest';
import { SwarmAgent, parseExpertOutput, buildJudgePrompt } from '../../src/llm/swarm-agent.js';
import type { EnrichedPromptData } from '../../src/llm/prompts.js';

const makeMinimalPromptData = (): EnrichedPromptData => ({
  snapshots: [],
  indicators: new Map(),
  portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] },
  signals: [],
  news: [],
  fearGreed: { value: 50, label: 'Neutral' },
});

const makeHighStakesPromptData = (): EnrichedPromptData => ({
  ...makeMinimalPromptData(),
  portfolio: {
    balanceUsd: 100,
    availableUsd: 50,
    sessionPnl: -5,
    positions: [{ pair: 'BTCUSDT', side: 'LONG', entryPrice: 70000, heldHours: 2, unrealizedPnlPct: -4.5, leverage: 10 }],
  },
});

const makeStructuredResponse = (persona: string, position: string, prob: number) =>
  JSON.stringify({
    persona,
    pair: 'BTCUSDT',
    position,
    thesis: `${persona} analysis`,
    arguments: ['arg1', 'arg2'],
    probability_of_success: prob,
    key_risks: ['risk1'],
    confidence: 80,
  });

const consensusResponse = `{"decisions": [{"pair": "BTCUSDT", "action": "HOLD", "confidence": 70, "reasoning": "mixed"}], "next_check_minutes": 15}`;

describe('SwarmAgent', () => {
  it('runs 5 experts + 5 critiques + 1 judge = 11 LLM calls (no Grok, no revise)', async () => {
    let callCount = 0;
    const mockRawCall = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 5) {
        const personas = ['risk_manager', 'bull_thesis', 'bear_thesis', 'market_structure', 'devils_advocate'];
        return Promise.resolve(makeStructuredResponse(personas[callCount - 1], 'HOLD', 60));
      }
      return Promise.resolve(consensusResponse);
    });
    const mockLlm = {
      call: mockRawCall,
      analyze: vi.fn(),
      model: 'test-model',
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // 5 experts + 5 critiques + 1 judge = 11
    expect(mockRawCall).toHaveBeenCalledTimes(11);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('HOLD');
  });

  it('with Grok: 5 Codex experts + 1 Grok + 6 critiques + 1 judge', async () => {
    let codexCallCount = 0;
    const mockCodex = {
      call: vi.fn().mockImplementation(() => {
        codexCallCount++;
        if (codexCallCount <= 5) {
          return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 55));
        }
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;
    const mockGrok = {
      call: vi.fn().mockResolvedValue(makeStructuredResponse('narrative_expert', 'HOLD', 50)),
    } as any;

    const agent = new SwarmAgent(mockCodex, mockGrok);
    await agent.getConsensus(makeMinimalPromptData());

    // 5 experts + 6 critiques (for all 6 personas) + 1 judge = 12
    expect(mockCodex.call).toHaveBeenCalledTimes(12);
    expect(mockGrok.call).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when consensus LLM call throws', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) {
          return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
        }
        return Promise.reject(new Error('API timeout'));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    expect(decisions).toEqual([]);
  });

  it('runs revise stage (3-stage) when high-stakes detected', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) {
          const personas = ['risk_manager', 'bull_thesis', 'bear_thesis', 'market_structure', 'devils_advocate'];
          return Promise.resolve(makeStructuredResponse(personas[callCount - 1], 'HOLD', 60));
        }
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeHighStakesPromptData());

    // 5 experts + 5 critiques + 5 revises + 1 judge = 16
    expect(mockLlm.call).toHaveBeenCalledTimes(16);
    expect(decisions).toHaveLength(1);
  });

  it('judge prompt contains structured expert data with probability_of_success and persona names', () => {
    const expertOutputs = [
      {
        persona: 'risk_manager',
        pair: 'BTCUSDT',
        position: 'HOLD',
        thesis: 'Too risky',
        arguments: ['high volatility', 'low liquidity'],
        probability_of_success: 30,
        key_risks: ['liquidation risk'],
        confidence: 90,
      },
      {
        persona: 'bull_thesis',
        pair: 'BTCUSDT',
        position: 'LONG',
        thesis: 'Breakout confirmed',
        arguments: ['EMA crossover'],
        probability_of_success: 75,
        key_risks: ['false breakout'],
        confidence: 80,
      },
      null, // bear_thesis failed
    ];
    const rawTexts = ['', '', 'raw bear text'];
    const personas = ['risk_manager', 'bull_thesis', 'bear_thesis'] as any;

    const prompt = buildJudgePrompt(expertOutputs, rawTexts, personas);

    expect(prompt).toContain('RISK_MANAGER');
    expect(prompt).toContain('BULL_THESIS');
    expect(prompt).toContain('BEAR_THESIS (parse failed)');
    expect(prompt).toContain('probability_of_success: 30%');
    expect(prompt).toContain('probability_of_success: 75%');
    expect(prompt).toContain('Too risky');
    expect(prompt).toContain('Breakout confirmed');
    expect(prompt).toContain('raw bear text');
    expect(prompt).toContain('SWARM CONSENSUS JUDGE');
  });

  it('malformed expert output handled gracefully (parseExpertOutput does not throw)', () => {
    const result1 = parseExpertOutput('this is not json at all', 'bull_thesis');
    expect(result1).toBeNull();

    const result2 = parseExpertOutput('{"foo": "bar"}', 'bear_thesis');
    expect(result2).toBeNull();

    const result3 = parseExpertOutput(
      'Here is my analysis: {"thesis": "bullish breakout", "probability_of_success": 70, "position": "LONG", "arguments": ["a"], "key_risks": ["b"], "confidence": 80, "pair": "BTCUSDT", "persona": "bull_thesis"}',
      'bull_thesis',
    );
    expect(result3).not.toBeNull();
    expect(result3!.thesis).toBe('bullish breakout');
    expect(result3!.probability_of_success).toBe(70);

    const result4 = parseExpertOutput('', 'risk_manager');
    expect(result4).toBeNull();

    // Array response (LLM returns one object per pair)
    const arrayResponse = JSON.stringify([
      { persona: 'bull', pair: 'BTCUSDT', position: 'LONG', thesis: 'breakout', arguments: ['a'], probability_of_success: 75, key_risks: ['r'], confidence: 80 },
      { persona: 'bull', pair: 'ETHUSDT', position: 'HOLD', thesis: 'wait', arguments: ['b'], probability_of_success: 40, key_risks: ['s'], confidence: 60 },
    ]);
    const result5 = parseExpertOutput(arrayResponse, 'bull_thesis');
    expect(result5).not.toBeNull();
    expect(result5!.thesis).toBe('breakout');
    expect(result5!.persona).toBe('bull_thesis');
  });

  it('tracks narrative_expert failure in sourceHealth', async () => {
    const mockGrokLlm = {
      call: vi.fn().mockRejectedValue(new Error('xAI Error: 401')),
    } as any;
    const mockSourceHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) return Promise.resolve(makeStructuredResponse('test', 'HOLD', 50));
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    await swarm.getConsensus(makeMinimalPromptData());

    expect(mockSourceHealth.recordFailure).toHaveBeenCalledWith(
      'grok-narrative', expect.stringContaining('401'),
    );
  });

  it('tracks narrative_expert success in sourceHealth', async () => {
    const mockGrokLlm = {
      call: vi.fn().mockResolvedValue(makeStructuredResponse('narrative_expert', 'HOLD', 50)),
    } as any;
    const mockSourceHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) return Promise.resolve(makeStructuredResponse('test', 'HOLD', 50));
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    await swarm.getConsensus(makeMinimalPromptData());

    expect(mockSourceHealth.recordSuccess).toHaveBeenCalledWith('grok-narrative');
  });
});
