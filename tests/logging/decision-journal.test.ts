import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DecisionJournal, type JournalEntry } from '../../src/logging/decision-journal.js';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { MarketRegime } from '../../src/market/regime-classifier.js';

const TEST_FILE = '/tmp/test-decision-journal.jsonl';

describe('DecisionJournal', () => {
    let journal: DecisionJournal;

    beforeEach(() => {
        if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
        journal = new DecisionJournal(TEST_FILE);
    });

    afterEach(() => {
        if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    });

    it('logs a decision entry as JSONL', () => {
        const entry: JournalEntry = {
            pair: 'BTCUSDT',
            regime: MarketRegime.BullTrend,
            regimeConfidence: 80,
            regimeOverride: null,
            filtersApplied: {
                rsi: { value: 55, range: [45, 80], passed: true },
                volume: { value: 0.7, min: 0.6, passed: true },
                confluence: { score: 3, min: 2, passed: true },
            },
            action: 'LONG',
            reasoning: 'Strong trend with pullback',
            confidence: 72,
            riskValidation: 'PASSED',
            indicatorsSnapshot: { rsi_1h: 55, rsi_4h: 60, volume_ratio: 0.7 },
        };

        journal.log(entry);

        const content = readFileSync(TEST_FILE, 'utf-8').trim();
        const parsed = JSON.parse(content);
        expect(parsed.pair).toBe('BTCUSDT');
        expect(parsed.regime).toBe('BullTrend');
        expect(parsed.ts).toBeDefined();
        expect(parsed.filters_applied.rsi.passed).toBe(true);
    });

    it('appends multiple entries', () => {
        journal.log({ pair: 'BTCUSDT', regime: MarketRegime.Range, regimeConfidence: 60, regimeOverride: null, filtersApplied: {}, action: 'HOLD', reasoning: 'test', confidence: 50, riskValidation: 'N/A', indicatorsSnapshot: {} });
        journal.log({ pair: 'ETHUSDT', regime: MarketRegime.Range, regimeConfidence: 60, regimeOverride: null, filtersApplied: {}, action: 'HOLD', reasoning: 'test', confidence: 50, riskValidation: 'N/A', indicatorsSnapshot: {} });

        const lines = readFileSync(TEST_FILE, 'utf-8').trim().split('\n');
        expect(lines.length).toBe(2);
    });

    it('does not throw on write errors', () => {
        const bad = new DecisionJournal('/nonexistent/path/journal.jsonl');
        expect(() => bad.log({ pair: 'X', regime: MarketRegime.Range, regimeConfidence: 0, regimeOverride: null, filtersApplied: {}, action: 'HOLD', reasoning: '', confidence: 0, riskValidation: 'N/A', indicatorsSnapshot: {} })).not.toThrow();
    });
});
