import type { MarketSnapshot } from '../binance/market-data.js';
import type { PortfolioState, TradeDecision } from '../risk/manager.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

export class LLMClient {
  constructor(
    private openai: any,
    private model: string,
  ) {}

  async analyze(
    snapshots: MarketSnapshot[],
    portfolio: PortfolioState,
    signals: TradingViewSignal[],
  ): Promise<TradeDecision[]> {
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(snapshots, portfolio, signals) },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content || '';
      return this.parseResponse(content);
    } catch (err) {
      console.error('[LLM] API error:', err);
      return [];
    }
  }

  private parseResponse(content: string): TradeDecision[] {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.decisions || !Array.isArray(parsed.decisions)) return [];

      return parsed.decisions;
    } catch {
      console.error('[LLM] Failed to parse response:', content.slice(0, 200));
      return [];
    }
  }
}
