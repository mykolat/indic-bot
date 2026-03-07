import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketRegime } from '../market/regime-classifier.js';

export interface FilterCheck {
    value?: number;
    range?: [number, number];
    min?: number;
    score?: number;
    passed: boolean;
}

export interface JournalEntry {
    pair: string;
    regime: MarketRegime;
    regimeConfidence: number;
    regimeOverride: string | null;
    filtersApplied: Record<string, FilterCheck>;
    action: string;
    reasoning: string;
    confidence: number;
    riskValidation: string;
    indicatorsSnapshot: Record<string, number | string>;
    session?: string;
    sessionPatternActive?: boolean;
    sessionFitScore?: number;
    sessionRole?: string;
    sessionReason?: string;
}

export class DecisionJournal {
    constructor(private logFile: string) { }

    log(entry: JournalEntry): void {
        try {
            mkdirSync(dirname(this.logFile), { recursive: true });
            const line = JSON.stringify({
                ts: new Date().toISOString(),
                pair: entry.pair,
                regime: entry.regime,
                regime_confidence: entry.regimeConfidence,
                regime_override: entry.regimeOverride,
                filters_applied: entry.filtersApplied,
                action: entry.action,
                reasoning: entry.reasoning,
                confidence: entry.confidence,
                risk_validation: entry.riskValidation,
                indicators_snapshot: entry.indicatorsSnapshot,
                session: entry.session,
                session_pattern_active: entry.sessionPatternActive,
                session_fit_score: entry.sessionFitScore,
                session_role: entry.sessionRole,
                session_reason: entry.sessionReason,
            }) + '\n';
            appendFileSync(this.logFile, line, 'utf-8');
        } catch {
            // Non-critical — never crash the bot over logging
        }
    }
}
