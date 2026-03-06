import { describe, it, expect } from 'vitest';
import { buildExpertSystemPrompt } from '../../src/llm/prompts.js';

describe('buildExpertSystemPrompt', () => {
  it('risk_manager focuses on reasons NOT to trade', () => {
    const prompt = buildExpertSystemPrompt('risk_manager');
    expect(prompt).toContain('reasons NOT to trade');
    expect(prompt).toContain('catastrophic loss');
  });

  it('devils_advocate must argue OPPOSITE and be contrarian', () => {
    const prompt = buildExpertSystemPrompt('devils_advocate');
    expect(prompt).toContain('OPPOSITE');
    expect(prompt).toContain('contrarian');
    expect(prompt).toContain('NEVER agree with the majority');
  });

  it('market_structure focuses on microstructure signals', () => {
    const prompt = buildExpertSystemPrompt('market_structure');
    expect(prompt).toContain('Funding rate');
    expect(prompt).toContain('Open interest');
  });
});
