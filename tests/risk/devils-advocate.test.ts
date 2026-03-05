import { describe, it, expect, vi } from 'vitest';
import { DevilsAdvocate } from '../../src/risk/devils-advocate.js';

describe('DevilsAdvocate', () => {
    it('returns veto if negative sentiment found', async () => {
        const mockGrok = {
            call: vi.fn().mockResolvedValue('{"veto": true, "reason": "Found hacked rumors on X"}')
        } as any;

        const advocate = new DevilsAdvocate(mockGrok);
        const res = await advocate.checkTrade('BTCUSDT', 'LONG');

        expect(res.veto).toBe(true);
        expect(mockGrok.call).toHaveBeenCalled();
    });
});
