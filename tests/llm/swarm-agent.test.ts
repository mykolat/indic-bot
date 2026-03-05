import { describe, it, expect, vi } from 'vitest';
import { SwarmAgent } from '../../src/llm/swarm-agent.js';

describe('SwarmAgent', () => {
    it('runs 3 personas and a consensus maker', async () => {
        const mockRawCall = vi.fn().mockResolvedValue('{"decisions": [{"pair": "BTCUSDT", "action": "HOLD"}], "next_check_minutes": 10}');
        const mockLlm = {
            call: mockRawCall,
            analyze: vi.fn(), // Not used by SwarmAgent directly
            model: 'test-model',
            lastNextCheckMinutes: undefined
        } as any;

        const agent = new SwarmAgent(mockLlm);
        const decisions = await agent.getConsensus({ snapshots: [], indicators: new Map(), portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] }, signals: [], news: [], fearGreed: { value: 50, label: 'Neutral' } });

        expect(mockRawCall).toHaveBeenCalledTimes(4); // 3 personas + 1 consensus
        expect(decisions).toHaveLength(1);
        expect(decisions[0].action).toBe('HOLD');
    });

    it('requests consensus from both Codex and Grok', async () => {
        const mockCodex = { call: vi.fn().mockResolvedValue('Codex View') } as any;
        const mockGrok = { call: vi.fn().mockResolvedValue('Grok View') } as any;

        // Final analyze mock for the judge
        mockCodex.call.mockResolvedValueOnce('Codex View')
            .mockResolvedValueOnce('Codex View')
            .mockResolvedValueOnce('Codex View')
            .mockResolvedValueOnce('{ "decisions": [] }');

        const agent = new SwarmAgent(mockCodex, mockGrok);
        await agent.getConsensus({ snapshots: [], indicators: new Map(), portfolio: { balanceUsd: 100, sessionPnl: 0, positions: [] }, signals: [], news: [], fearGreed: { value: 50, label: 'Neutral' } } as any);

        expect(mockCodex.call).toHaveBeenCalledTimes(4); // 3 personas + 1 judge
        expect(mockGrok.call).toHaveBeenCalledTimes(1);  // 1 narrative expert
    });

    it('returns empty array when consensus LLM call throws', async () => {
        const mockLlm = {
            call: vi.fn()
                .mockResolvedValueOnce('bull view')
                .mockResolvedValueOnce('bear view')
                .mockResolvedValueOnce('risk view')
                .mockRejectedValueOnce(new Error('API timeout')),
            lastNextCheckMinutes: undefined
        } as any;

        const agent = new SwarmAgent(mockLlm);
        const decisions = await agent.getConsensus({ snapshots: [], indicators: new Map(), portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] }, signals: [], news: [], fearGreed: { value: 50, label: 'Neutral' } });

        expect(decisions).toEqual([]);
    });

    it('parses JSON with nested objects in decisions', async () => {
        const nestedJson = '{"decisions": [{"pair": "ETHUSDT", "action": "LONG", "meta": {"reason": "breakout"}}], "next_check_minutes": 5}';
        const mockLlm = {
            call: vi.fn().mockResolvedValue(nestedJson),
            lastNextCheckMinutes: undefined
        } as any;

        const agent = new SwarmAgent(mockLlm);
        const decisions = await agent.getConsensus({ snapshots: [], indicators: new Map(), portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] }, signals: [], news: [], fearGreed: { value: 50, label: 'Neutral' } });

        expect(decisions).toHaveLength(1);
        expect(decisions[0].pair).toBe('ETHUSDT');
    });
});
