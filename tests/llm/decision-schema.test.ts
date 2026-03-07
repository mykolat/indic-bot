import { describe, it, expect } from 'vitest';
import { parseDecisions, type LLMResponse, type DecisionV2 } from '../../src/llm/decision-schema.js';

describe('parseDecisions', () => {
  const validResponse: LLMResponse = {
    decisions: [{
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 5,
      stop_loss_pct: 2,
      take_profit_pct: 6,
      reasoning: 'Strong trend continuation with volume confirmation',
      confidence: 72,
      setup_detected: true,
      setup_type: 'trend_continuation',
      directional_bias: 'long',
      entry_valid_now: true,
      invalidators: ['4h EMA cross bearish', 'volume drop below 0.5x'],
      risk_flags: [],
      data_gaps: [],
      abstain_reason: null,
    }],
    next_check_minutes: 15,
  };

  it('parses a valid response', () => {
    const result = parseDecisions(JSON.stringify(validResponse));
    expect(result).not.toBeNull();
    expect(result!.decisions).toHaveLength(1);
    expect(result!.decisions[0].action).toBe('LONG');
    expect(result!.decisions[0].setup_detected).toBe(true);
    expect(result!.decisions[0].invalidators).toHaveLength(2);
    expect(result!.nextCheckMinutes).toBe(15);
  });

  it('parses a HOLD with abstain_reason', () => {
    const hold: LLMResponse = {
      decisions: [{
        pair: 'BTCUSDT',
        action: 'HOLD',
        size_pct: 0,
        leverage: 0,
        stop_loss_pct: 0,
        take_profit_pct: 0,
        reasoning: 'low_volume',
        confidence: 30,
        setup_detected: false,
        setup_type: 'none',
        directional_bias: 'neutral',
        entry_valid_now: false,
        invalidators: [],
        risk_flags: ['thin_book'],
        data_gaps: ['missing_macro'],
        abstain_reason: 'no_setup',
      }],
      next_check_minutes: 25,
    };
    const result = parseDecisions(JSON.stringify(hold));
    expect(result).not.toBeNull();
    expect(result!.decisions[0].abstain_reason).toBe('no_setup');
    expect(result!.decisions[0].data_gaps).toContain('missing_macro');
  });

  it('returns null on invalid JSON', () => {
    expect(parseDecisions('not json at all')).toBeNull();
  });

  it('returns null on missing decisions array', () => {
    expect(parseDecisions('{"foo": "bar"}')).toBeNull();
  });

  it('clamps next_check_minutes to 10-30 range', () => {
    const response = { ...validResponse, next_check_minutes: 5 };
    const result = parseDecisions(JSON.stringify(response));
    expect(result!.nextCheckMinutes).toBe(10);
  });

  it('defaults missing optional fields', () => {
    const minimal: LLMResponse = {
      decisions: [{
        pair: 'ETHUSDT',
        action: 'SHORT',
        size_pct: 15,
        leverage: 8,
        stop_loss_pct: 1.5,
        take_profit_pct: 4,
        reasoning: 'Breakdown below VWAP',
        confidence: 65,
      } as any],
      next_check_minutes: 10,
    };
    const result = parseDecisions(JSON.stringify(minimal));
    expect(result).not.toBeNull();
    const d = result!.decisions[0];
    expect(d.setup_detected).toBe(false);
    expect(d.directional_bias).toBe('neutral');
    expect(d.risk_flags).toEqual([]);
    expect(d.data_gaps).toEqual([]);
    expect(d.abstain_reason).toBeNull();
    expect(d.invalidators).toEqual([]);
  });
});
