import type { LLMClient } from '../llm/client.js';
import type { TradeRecord } from './session.js';

/**
 * Minimal interface for SoulKeeper methods used by SoulReviewAgent.
 * The full SoulKeeper class is defined in ./soul-keeper.ts.
 */
export interface SoulReviewSoulKeeper {
  read(): string;
  writeNarrativeSections(sections: {
    identity?: string;
    learned?: string;
    failures?: string;
    regime?: string;
  }): void;
}

const SOUL_REVIEW_SYSTEM = `You are reviewing your own trading soul document — your persistent identity and memory as a crypto futures trading agent.

Your task: Update the narrative sections based on your recent performance and decisions. Be honest, specific, and actionable.

Respond with EXACTLY this JSON format:
{
  "identity": "2-4 sentences about who you are as a trader and your current style",
  "learned": "2-4 sentences about key lessons from recent trading",
  "failures": "2-4 sentences about recurring mistakes and patterns to avoid",
  "regime": "2-4 sentences about your current market view and bias"
}

Rules:
- Be brutally honest about failures — do not rationalize losses
- Reference specific pairs and patterns from your data
- Keep each section concise (2-4 sentences max)
- If win rate is low, acknowledge it. If you keep getting rejected, analyze why.
- Adapt your regime view based on recent market conditions`;

export interface SoulReviewDeps {
  llm: LLMClient;
  soulKeeper: SoulReviewSoulKeeper;
}

export class SoulReviewAgent {
  private llm: LLMClient;
  private soulKeeper: SoulReviewSoulKeeper;
  private lastReviewCycle = 0;
  private reviewIntervalCycles: number;

  constructor(deps: SoulReviewDeps, reviewIntervalCycles = 20) {
    this.llm = deps.llm;
    this.soulKeeper = deps.soulKeeper;
    this.reviewIntervalCycles = reviewIntervalCycles;
  }

  shouldReview(cycleCount: number, consecutiveLosses: number, sessionPnlPctDelta: number): boolean {
    // Every N cycles
    if (cycleCount - this.lastReviewCycle >= this.reviewIntervalCycles) return true;
    // After 3+ consecutive losses
    if (consecutiveLosses >= 3) return true;
    // After significant balance change (>3%)
    if (Math.abs(sessionPnlPctDelta) > 3) return true;
    return false;
  }

  async review(recentTrades: TradeRecord[], recentDecisions: string[]): Promise<void> {
    const currentSoul = this.soulKeeper.read();

    const userPrompt = `Here is your current soul document:

${currentSoul}

Recent closed trades (newest first):
${recentTrades.slice(0, 10).map(t => {
  const sign = t.pnlPct >= 0 ? '+' : '';
  return `- ${t.pair} ${t.action}: ${sign}${t.pnlPct.toFixed(1)}% (${sign}$${t.pnlUsd.toFixed(2)}) at ${t.closedAt}`;
}).join('\n') || 'No recent trades.'}

Recent decision log (last 10):
${recentDecisions.slice(0, 10).join('\n') || 'No recent decisions.'}

Update the four narrative sections.`;

    try {
      const response = await this.llm.call(SOUL_REVIEW_SYSTEM, userPrompt);

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*"identity"[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[SoulReview] Failed to parse LLM response');
        return;
      }

      const sections = JSON.parse(jsonMatch[0]) as {
        identity?: string;
        learned?: string;
        failures?: string;
        regime?: string;
      };

      this.soulKeeper.writeNarrativeSections(sections);
      this.lastReviewCycle = Date.now(); // Use timestamp for simplicity
      console.log('[SoulReview] Narrative sections updated');
    } catch (err) {
      console.error('[SoulReview] Review failed:', err);
    }
  }
}
