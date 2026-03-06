import { fetchWithTimeout } from '../utils/fetch-timeout.js';

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';

const GROUNDING_PROMPT = `You are a crypto news fact-checker with real-time X/Twitter access.
Given a claim about crypto markets, search X for verification.

Return ONLY valid JSON:
{
  "verified": true|false|null,
  "confidence": <0-1>,
  "summary": "1-2 sentences: what you found on X",
  "sources": ["@account1", "@account2"],
  "contradictions": ["any contradicting evidence"]
}

Rules:
- verified=true: multiple credible sources confirm
- verified=false: contradicted by official sources or clearly fake
- verified=null: insufficient data to determine
- confidence: 0=no data, 0.5=mixed signals, 1.0=certain
- sources: X accounts that discuss this claim`;

export interface GroundingResult {
  claim: string;
  verified?: boolean | null;
  confidence?: number;
  summary?: string;
  sources?: string[];
  contradictions?: string[];
  tokensUsed: number;
  error?: string;
}

export class GrokGrounder {
  constructor(private xaiApiKey: string, private sourceHealth?: { recordSuccess(source: string): void; recordFailure(source: string, reason: string): void }) { }

  async verify(claim: string): Promise<GroundingResult> {
    try {
      const response = await fetchWithTimeout(
        XAI_API_URL,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.xaiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'grok-3',
            messages: [
              { role: 'system', content: GROUNDING_PROMPT },
              { role: 'user', content: `Verify this crypto claim using X/Twitter search:\n\n"${claim}"` },
            ],
            temperature: 0,
          }),
        },
        30_000,
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`xAI API ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = (await response.json()) as any;
      const content = data.choices?.[0]?.message?.content ?? '';
      const tokensUsed = data.usage?.total_tokens ?? 0;

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { claim, summary: content.slice(0, 300), tokensUsed };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      this.sourceHealth?.recordSuccess('grok-grounder');
      return {
        claim,
        verified: parsed.verified,
        confidence: parsed.confidence,
        summary: parsed.summary,
        sources: parsed.sources,
        contradictions: parsed.contradictions,
        tokensUsed,
      };
    } catch (err: any) {
      if (!err?.message?.includes('timeout') && !err?.message?.includes('401')) {
        console.error('[GrokGrounder] Error:', err?.message);
      }
      this.sourceHealth?.recordFailure('grok-grounder', err?.message ?? 'unknown');
      return { claim, error: err?.message, tokensUsed: 0 };
    }
  }
}
