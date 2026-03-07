import type { GrokClient } from '../llm/grok-client.js';
import type { MacroAnalysis } from '../llm/prompts.js';
import { insertMacroSnapshot, insertMacroAnalysis } from '../db/repository.js';

const SYSTEM_PROMPT = `You are a macro markets analyst for a crypto futures trading bot. Use LIVE SEARCH to look up current prices. Do NOT guess or use stale data.

Your job:
1. Look up current prices for: DXY (Dollar Index), VIX, S&P 500, WTI Oil, Gold, EUR/USD, BTC dominance
2. Assess risk environment for crypto trading
3. Give a 1-sentence brief for each crypto pair listed

Return ONLY valid JSON (no markdown, no code blocks):
{
  "macro_summary": "2-3 sentence macro narrative with crypto implications",
  "risk_environment": "risk_on" | "risk_off" | "neutral",
  "crypto_correlation_signal": "bullish" | "bearish" | "neutral",
  "key_levels": ["DXY 104.5 — resistance", "VIX 18 — low fear"],
  "pair_briefs": {
    "BTCUSDT": "1 sentence: price level, trend, key driver",
    "ETHUSDT": "1 sentence: price level, trend, key driver"
  },
  "macro_data": {
    "dxy": 104.5,
    "vix": 18.2,
    "sp500": 5800,
    "wti": 72.3,
    "gold": 2650,
    "eurusd": 1.08,
    "btc_dominance": 56.7
  }
}

Rules:
- risk_off = DXY rising + VIX rising + S&P falling = bad for crypto
- risk_on = DXY falling + VIX falling + S&P rising = good for crypto
- pair_briefs: mention current price, 24h direction, and the single most important factor
- macro_data: use EXACT current values from search, not estimates
- All prices must be from TODAY, not historical`;

interface GrokMacroResult extends MacroAnalysis {
  macro_data?: {
    dxy?: number;
    vix?: number;
    sp500?: number;
    wti?: number;
    gold?: number;
    eurusd?: number;
    btc_dominance?: number;
  };
}

const FALLBACK: MacroAnalysis = {
  macro_summary: 'Macro data unavailable.',
  risk_environment: 'neutral',
  crypto_correlation_signal: 'neutral',
  key_levels: [],
  pair_briefs: {},
  refreshed_at: new Date().toISOString(),
};

export class GrokMacroAnalyst {
  constructor(private grok: GrokClient) {}

  async analyze(pairs: string[]): Promise<MacroAnalysis> {
    try {
      const userPrompt = [
        `Current time: ${new Date().toISOString()}`,
        ``,
        `Look up LIVE current prices for: DXY, VIX, S&P 500, WTI Crude Oil, Gold, EUR/USD, BTC dominance.`,
        ``,
        `Then give a 1-sentence market brief for each of these crypto futures pairs:`,
        ...pairs.map(p => `- ${p}`),
      ].join('\n');

      const raw = await this.grok.call(
        SYSTEM_PROMPT,
        userPrompt,
        'grok-4-1-fast-non-reasoning',
        { search: true, temperature: 0 },
      );

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        console.error('[GrokMacro] No JSON in response');
        return { ...FALLBACK, refreshed_at: new Date().toISOString() };
      }

      const parsed = JSON.parse(match[0]) as GrokMacroResult;
      parsed.refreshed_at = new Date().toISOString();

      // Save macro_data to DB
      if (parsed.macro_data) {
        const d = parsed.macro_data;
        insertMacroSnapshot({
          dxy: d.dxy, vix: d.vix, sp500: d.sp500,
          wti: d.wti, gold: d.gold, eurusd: d.eurusd,
          btc_dominance: d.btc_dominance,
        }).catch(() => {});
      }

      // Save analysis to DB
      insertMacroAnalysis({
        summary: parsed.macro_summary,
        risk_level: parsed.risk_environment,
        key_factors: {
          key_levels: parsed.key_levels,
          crypto_signal: parsed.crypto_correlation_signal,
          pair_briefs: parsed.pair_briefs,
        },
      }).catch(() => {});

      console.log(`[GrokMacro] ${parsed.risk_environment} / crypto: ${parsed.crypto_correlation_signal} (${Object.keys(parsed.pair_briefs ?? {}).length} pair briefs)`);
      return parsed;
    } catch (err: any) {
      console.error('[GrokMacro] Error:', err.message);
      return { ...FALLBACK, refreshed_at: new Date().toISOString() };
    }
  }
}
