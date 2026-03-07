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

/** PersonaUpdate format for blackboard pattern */
const makePersonaUpdate = (direction: string = 'HOLD', confidence: number = 80, prob: number = 40) =>
  JSON.stringify({
    signals: { bullish: ['ema_bounce'], bearish: [], neutral: [] },
    vote: { d: direction, c: confidence, prob, reason: 'test_reason' },
    risks: ['liq_cascade'],
    conflicts_with: {},
  });

/** PersonaUpdate that conflicts with another persona */
const makeConflictingUpdate = (direction: string, confidence: number, conflictCode: string, conflictReason: string) =>
  JSON.stringify({
    signals: { bullish: direction === 'LONG' ? ['breakout'] : [], bearish: direction === 'SHORT' ? ['breakdown'] : [], neutral: [] },
    vote: { d: direction, c: confidence, prob: 60, reason: `${direction.toLowerCase()}_setup` },
    risks: ['reversal_risk'],
    conflicts_with: { [conflictCode]: conflictReason },
  });

const makeJudgeResponse = (cont: boolean = false, decisions?: any[], nextSpeakers?: string[]) =>
  JSON.stringify({
    continue: cont,
    verdict: cont ? 'conflict_unresolved' : 'consensus_hold',
    decisions: decisions ?? [{ pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 1, stop_loss_pct: 2, take_profit_pct: 4, confidence: 45, reasoning: 'low_edge' }],
    next_check_minutes: 15,
    ...(nextSpeakers ? { next_speakers: nextSpeakers } : {}),
  });

describe('SwarmAgent (Blackboard Pattern)', () => {
  it('basic consensus: all agree HOLD → 1 round (3 experts + 1 judge = 4 calls)', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    expect(mockLlm.call).toHaveBeenCalledTimes(4);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('HOLD');
  });

  it('conflict triggers round 2: BT LONG vs BA SHORT → judge continues → round 2 with only conflicting personas', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        // Round 1: 3 experts (RM=HOLD, MS=HOLD, DA=HOLD)
        if (callCount === 1) return Promise.resolve(makePersonaUpdate('HOLD', 70, 30)); // RM
        if (callCount === 2) return Promise.resolve(makePersonaUpdate('HOLD', 60, 40)); // MS
        if (callCount === 3) return Promise.resolve(makePersonaUpdate('HOLD', 50, 30)); // DA
        // Round 1 judge: continue (there are conflicts from separate BT/BA that we simulate)
        if (callCount === 4) return Promise.resolve(makeJudgeResponse(true, [], ['RM', 'MS']));
        // Round 2: 2 speakers
        if (callCount <= 6) return Promise.resolve(makePersonaUpdate('HOLD', 75, 50));
        // Round 2 judge: stop
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // Round 1: 3 experts + 1 judge = 4
    // Round 2: 2 speakers (from next_speakers) + 1 judge = 3
    // Total = 7
    expect(mockLlm.call).toHaveBeenCalledTimes(7);
    expect(decisions).toHaveLength(1);
  });

  it('conflict-based round 2: blackboard detects LONG vs SHORT conflict → reruns only conflicting personas', async () => {
    // This test uses 4 personas (with grok) to verify conflict detection
    let codexCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        codexCount++;
        // Round 1: RM, MS, DA (3 codex calls)
        if (codexCount === 1) return Promise.resolve(makeConflictingUpdate('LONG', 70, 'DA', 'direction_disagree')); // RM says LONG, conflicts with DA
        if (codexCount === 2) return Promise.resolve(makePersonaUpdate('HOLD', 60, 40)); // MS
        if (codexCount === 3) return Promise.resolve(makeConflictingUpdate('SHORT', 65, 'RM', 'direction_disagree')); // DA says SHORT, conflicts with RM
        // Round 1 judge: continue (bb has high-severity RM vs DA conflict)
        if (codexCount === 4) return Promise.resolve(makeJudgeResponse(true));
        // Round 2: only RM and DA (conflicting speakers from blackboard)
        if (codexCount <= 6) return Promise.resolve(makePersonaUpdate('HOLD', 80, 50));
        // Round 2 judge: stop
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // Round 1: 3 experts + 1 judge = 4
    // Round 2: 2 conflicting speakers (RM, DA) + 1 judge = 3
    // Total = 7
    expect(mockLlm.call).toHaveBeenCalledTimes(7);
    expect(decisions).toHaveLength(1);
  });

  it('caps at MAX_ROUNDS=3 even if Judge always says continue', async () => {
    const judgeContinue = makeJudgeResponse(true, [], ['RM', 'MS']);

    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        // Round 1: 3 experts + 1 judge = 4
        // Round 2: 2 speakers + 1 judge = 3
        // Round 3: 2 speakers + 1 judge = 3
        // Total = 10
        // Return expert responses for all persona calls, judge for judge calls
        // Calls: 1,2,3=R1 experts; 4=R1 judge; 5,6=R2 experts; 7=R2 judge; 8,9=R3 experts; 10=R3 judge
        if ([4, 7].includes(callCount)) return Promise.resolve(judgeContinue);
        if (callCount >= 10) return Promise.resolve(makeJudgeResponse(false)); // R3 judge must stop
        return Promise.resolve(makePersonaUpdate('HOLD', 60, 40));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // Max 3 rounds: 3 + 1 + 2 + 1 + 2 + 1 = 10 max
    expect(mockLlm.call.mock.calls.length).toBeLessThanOrEqual(10);
    expect(decisions).toHaveLength(1);
  });

  it('fingerprint dedup: skips debate when market state unchanged', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const data = makeMinimalPromptData();

    const d1 = await agent.getConsensus(data);
    expect(mockLlm.call).toHaveBeenCalledTimes(4);

    // Second call same data — cached, no new LLM calls
    const d2 = await agent.getConsensus(data);
    expect(mockLlm.call).toHaveBeenCalledTimes(4);
    expect(d2).toEqual(d1);
  });

  it('runs new debate when fingerprint changes (new position)', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3 || (callCount >= 5 && callCount <= 7)) {
          return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        }
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    await agent.getConsensus(makeMinimalPromptData());
    expect(mockLlm.call).toHaveBeenCalledTimes(4);

    // Add a position — fingerprint changes
    const data2 = {
      ...makeMinimalPromptData(),
      portfolio: {
        balanceUsd: 100, availableUsd: 50, sessionPnl: 0,
        positions: [{ pair: 'BTCUSDT', side: 'LONG' as const, entryPrice: 90000, heldHours: 1, unrealizedPnlPct: 2, leverage: 5 }],
      },
    };

    await agent.getConsensus(data2);
    expect(mockLlm.call).toHaveBeenCalledTimes(8);
  });

  it('re-runs debate after TTL expires even if fingerprint unchanged', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3 || (callCount >= 5 && callCount <= 7)) {
          return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        }
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const data = makeMinimalPromptData();

    await agent.getConsensus(data);
    expect(mockLlm.call).toHaveBeenCalledTimes(4);

    // Simulate TTL expiry
    (agent as any).lastDebateAt = Date.now() - 31 * 60_000;

    await agent.getConsensus(data);
    expect(mockLlm.call).toHaveBeenCalledTimes(8);
  });

  it('with Grok: 3 Codex + 1 Grok + 1 judge = 5 total', async () => {
    let codexCallCount = 0;
    const mockCodex = {
      call: vi.fn().mockImplementation(() => {
        codexCallCount++;
        if (codexCallCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 70, 40));
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;
    const mockGrok = {
      call: vi.fn().mockResolvedValue(makePersonaUpdate('HOLD', 50, 30)),
    } as any;

    const agent = new SwarmAgent(mockCodex, mockGrok);
    await agent.getConsensus(makeMinimalPromptData());

    // 3 codex experts + 1 judge = 4 codex calls, 1 grok call
    expect(mockCodex.call).toHaveBeenCalledTimes(4);
    expect(mockGrok.call).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when judge LLM call throws', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        return Promise.reject(new Error('API timeout'));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());
    expect(decisions).toEqual([]);
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
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        return Promise.resolve(makeJudgeResponse(false));
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
      call: vi.fn().mockResolvedValue(makePersonaUpdate('HOLD', 50, 30)),
    } as any;
    const mockSourceHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    await swarm.getConsensus(makeMinimalPromptData());

    expect(mockSourceHealth.recordSuccess).toHaveBeenCalledWith('grok-narrative');
  });

  it('sets llm.lastNextCheckMinutes from judge response', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('HOLD', 80, 40));
        return Promise.resolve(makeJudgeResponse(false));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    await agent.getConsensus(makeMinimalPromptData());

    expect(mockLlm.lastNextCheckMinutes).toBe(15);
  });

  it('returns TradeDecision[] format', async () => {
    const decisions = [
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 5, leverage: 3, stop_loss_pct: 2, take_profit_pct: 4, confidence: 70, reasoning: 'breakout' },
    ];
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePersonaUpdate('LONG', 80, 70));
        return Promise.resolve(makeJudgeResponse(false, decisions));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const result = await agent.getConsensus(makeMinimalPromptData());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pair: 'BTCUSDT', action: 'LONG', confidence: 70 });
  });
});

// ── Legacy export tests ────────────────────────────────────────────────

describe('parseExpertOutput (legacy)', () => {
  it('malformed expert output handled gracefully (does not throw)', () => {
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

    // Array response
    const arrayResponse = JSON.stringify([
      { persona: 'bull', pair: 'BTCUSDT', position: 'LONG', thesis: 'breakout', arguments: ['a'], probability_of_success: 75, key_risks: ['r'], confidence: 80 },
      { persona: 'bull', pair: 'ETHUSDT', position: 'HOLD', thesis: 'wait', arguments: ['b'], probability_of_success: 40, key_risks: ['s'], confidence: 60 },
    ]);
    const result5 = parseExpertOutput(arrayResponse, 'bull_thesis');
    expect(result5).not.toBeNull();
    expect(result5!.thesis).toBe('breakout');
    expect(result5!.persona).toBe('bull_thesis');
  });
});

describe('buildJudgePrompt (legacy)', () => {
  it('contains structured expert data with probability_of_success and persona names', () => {
    const expertOutputs = [
      {
        persona: 'risk_manager', pair: 'BTCUSDT', position: 'HOLD',
        thesis: 'Too risky', arguments: ['high volatility', 'low liquidity'],
        probability_of_success: 30, key_risks: ['liquidation risk'], confidence: 90,
      },
      {
        persona: 'bull_thesis', pair: 'BTCUSDT', position: 'LONG',
        thesis: 'Breakout confirmed', arguments: ['EMA crossover'],
        probability_of_success: 75, key_risks: ['false breakout'], confidence: 80,
      },
      null,
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
});
