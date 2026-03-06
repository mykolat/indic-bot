import { describe, it, expect } from 'vitest';
import { buildUserPrompt, buildExpertSystemPrompt, buildCritiquePrompt, buildRevisePrompt, type EnrichedPromptData } from '../../src/llm/prompts.js';

describe('buildUserPrompt', () => {
    it('should inject filterWarning if provided', () => {
        const prompt = buildUserPrompt({
            snapshots: [],
            indicators: new Map(),
            portfolio: { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 },
            signals: [],
            news: [],
            fearGreed: { value: 50, label: 'Neutral' },
            filterWarning: 'Volume 0.3x < 0.6x',
        });
        expect(prompt).toContain('>>> ⚠️ SHARK MODE WARNING ⚠️ <<<');
        expect(prompt).toContain('System technical filters FAILED: Volume 0.3x < 0.6x');
    });

    it('should render positionContexts with SL/TP and entry thesis', () => {
        const prompt = buildUserPrompt({
            snapshots: [{ pair: 'BTCUSDT', markPrice: '72000', candles1h: [], candles15m: [], fundingRate: '0.0001', openInterest: '1000', longShortRatio: 1.0, orderBookBidPct: 50, orderBookAskPct: 50 }] as any,
            indicators: new Map(),
            portfolio: { balanceUsd: 100, positions: [{ pair: 'BTCUSDT', side: 'LONG', entryPrice: 70000, heldHours: 2, unrealizedPnlPct: 2.8, leverage: 10 }], sessionPnl: 5, drawdownPct: 0 },
            signals: [],
            news: [],
            fearGreed: { value: 50, label: 'Neutral' },
            positionContexts: [{ pair: 'BTCUSDT', sl_price: 68000, tp_price: 78000, entry_thesis: 'Bullish breakout on volume', fill_price: 70000 }],
        });
        expect(prompt).toContain('SL: $68000');
        expect(prompt).toContain('TP: $78000');
        expect(prompt).toContain('Entry thesis: Bullish breakout on volume');
        expect(prompt).toContain('DO NOT close this position unless SL is hit');
    });

    it('includes recent decisions in prompt', () => {
        const data: EnrichedPromptData = {
            snapshots: [],
            indicators: new Map(),
            portfolio: { balanceUsd: 178, availableUsd: 178, sessionPnl: -6, positions: [] },
            signals: [], news: [],
            fearGreed: { value: 18, label: 'Extreme Fear' },
            recentDecisions: [{
                pair: 'ADAUSDT', action: 'SHORT', confidence: 58,
                reasoning: 'ADA bearish alignment on 1h and 4h',
                execution_result: 'ORDER_FAIL: Precision is over the maximum',
                created_at: new Date(Date.now() - 600000).toISOString(),
            }],
        };

        const prompt = buildUserPrompt(data);
        expect(prompt).toContain('Recent Decisions');
        expect(prompt).toContain('ADAUSDT SHORT');
        expect(prompt).toContain('ORDER_FAIL');
    });

    it('handles string sl_price/tp_price from DB without crashing', () => {
        const data: EnrichedPromptData = {
            snapshots: [{ pair: 'ADAUSDT', markPrice: '0.27', volume24h: 1000, priceChangePercent: -2, candles1h: [], candles15m: [], fundingRate: '0.0001', openInterest: '1000', longShortRatio: 1.0, orderBookBidPct: 50, orderBookAskPct: 50 }] as any,
            indicators: new Map(),
            portfolio: {
                balanceUsd: 178, availableUsd: 150, sessionPnl: -6,
                positions: [{ pair: 'ADAUSDT', side: 'SHORT', entryPrice: 0.2684, heldHours: 0.8, unrealizedPnlPct: 2.0, leverage: 5 }],
            },
            signals: [], news: [],
            fearGreed: { value: 18, label: 'Extreme Fear' },
            positionContexts: [{
                pair: 'ADAUSDT',
                sl_price: '0.2743' as any,  // string from DB
                tp_price: '0.2528' as any,  // string from DB
                fill_price: '0.2684' as any,
                entry_thesis: 'ADA bearish alignment',
            }],
        };

        const prompt = buildUserPrompt(data);
        expect(prompt).toContain('ADAUSDT');
        expect(prompt).toContain('SL:');
        expect(prompt).not.toContain('undefined');
    });
});

describe('Expert Prompts', () => {
    it('builds persona-specific expert prompts', () => {
        const risk = buildExpertSystemPrompt('risk_manager');
        expect(risk).toContain('PARANOID RISK MANAGER');
        expect(risk).toContain('"probability_of_success"');

        const bull = buildExpertSystemPrompt('bull_thesis');
        expect(bull).toContain('BULL THESIS ANALYST');

        const devil = buildExpertSystemPrompt('devils_advocate');
        expect(devil).toContain("DEVIL'S ADVOCATE");
    });

    it('risk_manager focuses on reasons NOT to trade', () => {
        const prompt = buildExpertSystemPrompt('risk_manager');
        expect(prompt).toContain('reasons NOT to trade');
        expect(prompt).toContain('catastrophic loss');
    });

    it('devils_advocate must argue AGAINST the majority', () => {
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

    it('builds critique prompt with other experts', () => {
        const prompt = buildCritiquePrompt('risk_manager', [
            { persona: 'bull_thesis', thesis: 'BTC breakout', position: 'LONG', probability_of_success: 75, arguments: ['momentum'], key_risks: ['reversal'] },
            { persona: 'risk_manager', thesis: 'too risky', position: 'HOLD', probability_of_success: 30, arguments: ['drawdown'], key_risks: ['cascade'] },
        ]);
        expect(prompt).toContain('BULL_THESIS');
        expect(prompt).toContain('BTC breakout');
        expect(prompt).not.toContain('RISK_MANAGER\nPosition:'); // should filter self
    });

    it('builds revise prompt with critiques', () => {
        const prompt = buildRevisePrompt(
            'bull_thesis',
            { persona: 'bull_thesis', thesis: 'BTC breakout', position: 'LONG', probability_of_success: 75, arguments: ['momentum'], key_risks: ['reversal'], confidence: 80 },
            [{ from: 'risk_manager', agrees: false, critique: 'leverage too high', counter_argument: 'reduce to 5x' }],
        );
        expect(prompt).toContain('RISK_MANAGER DISAGREES');
        expect(prompt).toContain('leverage too high');
        expect(prompt).toContain('revised_position');
    });
});
