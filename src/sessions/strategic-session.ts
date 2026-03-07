import type { SessionDeps, MarketContext, DailyDirective } from './types.js';
import { insertDailyDirective, insertExpertCall } from '../db/repository.js';

export class StrategicSession {
  constructor(private deps: SessionDeps) {}

  async run(ctx: MarketContext): Promise<DailyDirective> {
    const experts: Array<{ name: string; provider: 'gpt' | 'grok'; prompt: string }> = [
      {
        name: 'strategist',
        provider: 'gpt',
        prompt: `You are a crypto strategist. Analyze the market and output a DailyDirective as JSON.

Market: ${JSON.stringify(ctx)}
Pairs: ${this.deps.pairs.join(', ')}

Output JSON: { "allowed_pairs": string[], "pair_bias": {"PAIR": "bullish"|"bearish"|"neutral"}, "max_exposure_pct": number, "risk_appetite": "conservative"|"normal"|"aggressive", "banned_pairs": string[], "key_levels": {"PAIR": {"support": number[], "resistance": number[]}}, "reasoning": string }`,
      },
      {
        name: 'risk_assessor',
        provider: 'gpt',
        prompt: `You are a risk manager. Review market conditions and recommend risk appetite and exposure limits.

Market: ${JSON.stringify(ctx)}

Output JSON: { "risk_appetite": string, "max_exposure_pct": number, "banned_pairs": string[], "reasoning": string }`,
      },
    ];

    if (this.deps.grok) {
      experts.push({
        name: 'grok_sentinel',
        provider: 'grok',
        prompt: `Crypto market right now. What's the mood on X/Twitter? Any fear events or unusual narratives?

Output JSON: { "mood": string, "fear_events": string[], "narratives": string[], "unusual": string[], "reasoning": string }`,
      });
    }

    const results = await Promise.allSettled(
      experts.map(async (expert) => {
        const start = Date.now();
        const llm = expert.provider === 'grok' && this.deps.grok ? this.deps.grok : this.deps.llm;
        const raw = await llm.call(expert.prompt, 'Provide your analysis as JSON.');
        const latency = Date.now() - start;

        insertExpertCall({
          tier: 'strategic',
          expert_name: expert.name,
          llm_provider: expert.provider,
          result: raw,
          latency_ms: latency,
        }).catch(() => {});

        return { name: expert.name, raw };
      }),
    );

    const directive = this.aggregateDirective(results, ctx);
    directive.session_id = this.deps.sessionId;
    directive.valid_until = new Date(Date.now() + 8 * 3600_000).toISOString();
    await insertDailyDirective(directive).catch(() => {});

    console.log(`[Strategic] Directive: ${directive.allowed_pairs.length} pairs, risk=${directive.risk_appetite}, exposure=${directive.max_exposure_pct}%`);
    return directive;
  }

  private aggregateDirective(
    results: PromiseSettledResult<{ name: string; raw: string }>[],
    _ctx: MarketContext,
  ): DailyDirective {
    const directive: DailyDirective = {
      allowed_pairs: this.deps.pairs,
      pair_bias: {},
      max_exposure_pct: 150,
      risk_appetite: 'normal',
      banned_pairs: [],
      key_levels: {},
      reasoning: '',
    };

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      try {
        const json = JSON.parse(r.value.raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        if (r.value.name === 'strategist') {
          if (json.allowed_pairs) directive.allowed_pairs = json.allowed_pairs;
          if (json.pair_bias) directive.pair_bias = json.pair_bias;
          if (json.key_levels) directive.key_levels = json.key_levels;
          if (json.reasoning) directive.reasoning = json.reasoning;
        }
        if (r.value.name === 'risk_assessor') {
          if (json.risk_appetite) directive.risk_appetite = json.risk_appetite;
          if (json.max_exposure_pct) directive.max_exposure_pct = json.max_exposure_pct;
          if (json.banned_pairs) directive.banned_pairs = json.banned_pairs;
        }
        if (r.value.name === 'grok_sentinel' && json.fear_events?.length > 0) {
          directive.risk_appetite = 'conservative';
          directive.reasoning += ` | Grok sentinel: ${json.fear_events.join(', ')}`;
        }
      } catch { /* ignore parse errors */ }
    }

    return directive;
  }
}
