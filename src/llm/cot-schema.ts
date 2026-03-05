export interface MandatoryCoTChecklist {
    macro_risk_score: number;            // 1-10
    liquidation_sweep_detected: boolean;
    order_book_imbalance_ratio: number;
    news_catalyst_strength: number;      // 1-10
    regime_override_suggestion: string | null;
    trade_rationale: string;
    confidence_score: number;            // 1-100
}

export function validateCoTChecklist(data: any): asserts data is MandatoryCoTChecklist {
    const requiredFields = [
        'macro_risk_score',
        'liquidation_sweep_detected',
        'order_book_imbalance_ratio',
        'news_catalyst_strength',
        'regime_override_suggestion',
        'trade_rationale',
        'confidence_score'
    ];

    for (const field of requiredFields) {
        if (!(field in data)) {
            throw new Error(`Missing field: ${field}`);
        }
    }
}
