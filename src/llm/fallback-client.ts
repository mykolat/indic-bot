import type { TradeDecision, Position } from '../risk/manager.js';
import { fetchWithTimeout } from '../utils/fetch-timeout.js';
import { extractExternalInsights } from '../utils/soul-utils.js';

const FALLBACK_API_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are an emergency position manager for a crypto futures bot. The primary AI is unavailable.
Your ONLY job: decide HOLD or CLOSE for each open position. Never suggest LONG or SHORT.
Be conservative — when in doubt, HOLD and let the exchange SL/TP handle it.
Respond ONLY with valid JSON, no explanation.`;

export class FallbackLLMClient {
  /**
   * @param throwOnError - if true, throws on API error instead of returning [].
   *   Used so TradingLoop can detect that Layer 2 is also down and enter Layer 3.
   *   Defaults to true (production behavior — caller detects fallback exhaustion).
   *   Pass false explicitly in tests / callers that want silent failure.
   */
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'gpt-4o-mini',
    private readonly throwOnError: boolean = true,
  ) {}

  async analyze(
    positions: Position[],
    sessionPnlPct: number,
    soulContent?: string,
  ): Promise<TradeDecision[]> {
    if (positions.length === 0) return [];

    const insights = soulContent ? extractExternalInsights(soulContent) : '';

    let userPrompt = `EMERGENCY MODE — only HOLD or CLOSE decisions allowed.\n\n`;
    userPrompt += `Session P&L: ${sessionPnlPct >= 0 ? '+' : ''}${sessionPnlPct.toFixed(2)}%\n\n`;
    userPrompt += `Open positions:\n`;
    for (const p of positions) {
      const sign = p.unrealizedPnlPct >= 0 ? '+' : '';
      userPrompt += `- ${p.pair} ${p.side}: PnL ${sign}${p.unrealizedPnlPct.toFixed(2)}%, held ${p.heldHours.toFixed(1)}h, size $${p.sizeUsd.toFixed(0)}\n`;
    }
    if (insights) {
      userPrompt += `\nBig Brother instructions:\n${insights}\n`;
    }
    userPrompt += `\nRespond ONLY with JSON:\n{"decisions":[{"pair":"BTCUSDT","action":"HOLD","confidence":80,"reasoning":"brief reason"}]}`;

    try {
      const response = await fetchWithTimeout(FALLBACK_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 400,
          temperature: 0.1,
        }),
      }, 15_000);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Fallback API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json() as any;
      const content: string = data.choices?.[0]?.message?.content ?? '';

      const match = content.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
      if (!match) return [];

      let parsed: any;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        console.error('[FallbackLLM] Parse error — returning []');
        return [];
      }
      if (!Array.isArray(parsed.decisions)) return [];

      // Hard guard: ONLY HOLD and CLOSE allowed
      return (parsed.decisions as any[])
        .filter(d => d.action === 'HOLD' || d.action === 'CLOSE')
        .map(d => ({
          pair: d.pair,
          action: d.action,
          size_pct: 0,
          leverage: 0,
          stop_loss_pct: 0,
          take_profit_pct: 0,
          reasoning: d.reasoning ?? 'fallback mode',
          confidence: d.confidence,
        }));
    } catch (err) {
      console.error('[FallbackLLM] Error:', err);
      if (this.throwOnError) throw err;
      return [];
    }
  }
}
