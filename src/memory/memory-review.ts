import type { LLMClient } from '../llm/client.js';
import type { TradeRecord } from './session.js';
import { insertMemoryReview } from '../db/repository.js';

/**
 * Minimal interface for SoulKeeper methods used by SoulReviewAgent.
 * The full SoulKeeper class is defined in ./soul-keeper.ts.
 */
export interface MemoryReviewMemoryKeeper {
  read(): string;
  writeNarrativeSections(sections: {
    identity?: string;
    learned?: string;
    failures?: string;
    regime?: string;
  }): void;
  backupHistory(): void;
}

const MEMORY_REVIEW_SYSTEM = `You are reviewing your runtime memory document — an essential record of your changing perspective.

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

export interface MemoryReviewDeps {
  llm: LLMClient;
  memoryKeeper: MemoryReviewMemoryKeeper;
}

export class MemoryReviewAgent {
  private llm: LLMClient;
  private memoryKeeper: MemoryReviewMemoryKeeper;
  private lastReviewCycle = 0;
  private reviewIntervalCycles: number;
  sessionId: string | undefined;

  constructor(deps: MemoryReviewDeps, reviewIntervalCycles = 20) {
    this.llm = deps.llm;
    this.memoryKeeper = deps.memoryKeeper;
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

  async review(recentTrades: TradeRecord[], recentDecisions: string[], cycleCount: number): Promise<void> {
    const currentMemory = this.memoryKeeper.read();

    const userPrompt = `Here is your current memory document:

${currentMemory}

Recent closed trades (newest first):
${recentTrades.slice(0, 10).map(t => {
      const sign = t.pnlPct >= 0 ? '+' : '';
      return `- ${t.pair} ${t.action}: ${sign}${t.pnlPct.toFixed(1)}% (${sign}$${t.pnlUsd.toFixed(2)}) at ${t.closedAt}`;
    }).join('\n') || 'No recent trades.'}

Recent decision log (last 10):
${recentDecisions.slice(0, 10).join('\n') || 'No recent decisions.'}

Update the four narrative sections.`;

    try {
      const response = await this.llm.call(MEMORY_REVIEW_SYSTEM, userPrompt);

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*"learned"[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[MemoryReview] Failed to parse LLM response');
        return;
      }

      const sections = JSON.parse(jsonMatch[0]) as {
        identity?: string;
        learned?: string;
        failures?: string;
        regime?: string;
      };

      // Backup existing memory history before overwriting with new reflections
      this.memoryKeeper.backupHistory();

      this.memoryKeeper.writeNarrativeSections(sections);

      // Save review to DB
      if (this.sessionId) {
        const triggerReason = cycleCount - this.lastReviewCycle >= this.reviewIntervalCycles
          ? 'periodic' : 'consecutive_losses_or_balance_change';
        insertMemoryReview({
          session_id: this.sessionId,
          cycle_number: cycleCount,
          trigger_reason: triggerReason,
          review_text: JSON.stringify(sections),
          actions_taken: Object.entries(sections).map(([section, content]) => ({
            section, action: 'update', content,
          })),
        }).catch(() => {});
      }

      this.lastReviewCycle = cycleCount;
      console.log('[MemoryReview] Narrative sections updated');
    } catch (err) {
      console.error('[MemoryReview] Review failed:', err);
    }
  }
}
