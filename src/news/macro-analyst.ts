import type { LLMClient } from '../llm/client.js';
import type { MacroSnapshot } from './macro-fetcher.js';

export interface MacroAnalysis {
  macro_summary: string;
  risk_environment: 'risk_on' | 'risk_off' | 'neutral';
  crypto_correlation_signal: 'bullish' | 'bearish' | 'neutral';
  key_levels: string[];
  refreshed_at: string;
}

const FALLBACK: MacroAnalysis = {
  macro_summary: 'Macro data unavailable.',
  risk_environment: 'neutral',
  crypto_correlation_signal: 'neutral',
  key_levels: [],
  refreshed_at: new Date().toISOString(),
};

const SYSTEM_PROMPT = `You are a macro markets analyst. Given current prices for oil, dollar index, S&P500, VIX, EUR/USD, and gold, return ONLY valid JSON (no markdown).

Return exactly this structure:
{
  "macro_summary": "2-3 sentence narrative of current macro environment and crypto implications",
  "risk_environment": "risk_on" | "risk_off" | "neutral",
  "crypto_correlation_signal": "bullish" | "bearish" | "neutral",
  "key_levels": ["DXY 104 resistance", "VIX 20 = fear threshold"],
  "refreshed_at": "<ISO timestamp>"
}

Rules:
- risk_off = DXY up + VIX up + S&P down = bad for crypto
- risk_on = DXY down + VIX down + S&P up = good for crypto
- Note intraday moves (day high/low vs current price) as trend context`;

export class MacroAnalystAgent {
  constructor(private llm: Pick<LLMClient, 'call'>) {}

  async analyze(snapshots: MacroSnapshot[], btcDominance?: { dominance: number } | null): Promise<MacroAnalysis> {
    try {
      let userPrompt = `Analyze current macro markets (${new Date().toISOString()}):\n\n`;
      for (const s of snapshots) {
        const midpoint = s.dayLow + (s.dayHigh - s.dayLow) * 0.5;
        const trend = s.price > midpoint ? 'upper half of range' : 'lower half of range';
        userPrompt += `${s.name} (${s.symbol}): $${s.price.toFixed(2)} | 24h: ${s.change24h >= 0 ? '+' : ''}${s.change24h.toFixed(2)}% | Day: L${s.dayLow.toFixed(2)}–H${s.dayHigh.toFixed(2)} (${trend})\n`;
      }
      if (btcDominance) {
        userPrompt += `BTC Dominance: ${btcDominance.dominance.toFixed(1)}%\n`;
      }

      const raw = await this.llm.call(SYSTEM_PROMPT, userPrompt);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { ...FALLBACK, refreshed_at: new Date().toISOString() };

      const parsed = JSON.parse(match[0]) as MacroAnalysis;
      parsed.refreshed_at = new Date().toISOString();
      console.log(`[MacroAnalyst] ${parsed.risk_environment} / crypto: ${parsed.crypto_correlation_signal}`);
      return parsed;
    } catch (err) {
      console.error('[MacroAnalyst] Error:', err);
      return { ...FALLBACK, refreshed_at: new Date().toISOString() };
    }
  }
}
