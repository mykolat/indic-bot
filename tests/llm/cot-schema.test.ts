import { describe, it, expect } from 'vitest';
import { validateCoTChecklist } from '../../src/llm/cot-schema.js';

describe('validateCoTChecklist', () => {
    it('validates a correct checklist payload', () => {
        const payload = {
            macro_risk_score: 8,
            liquidation_sweep_detected: true,
            order_book_imbalance_ratio: 1.5,
            news_catalyst_strength: 5,
            regime_override_suggestion: "Breakout",
            trade_rationale: "Strong volume push",
            confidence_score: 85
        };

        expect(() => validateCoTChecklist(payload)).not.toThrow();
    });

    it('throws on missing required fields', () => {
        const badPayload = { macro_risk_score: 8 };
        expect(() => validateCoTChecklist(badPayload)).toThrow('Missing field: liquidation_sweep_detected');
    });
});
