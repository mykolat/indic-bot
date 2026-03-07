import type { SessionDeps, MarketContext, DailyDirective, HourlyPlan } from './types.js';
import { insertHourlyPlan, insertExpertCall } from '../db/repository.js';

export class TacticalSession {
  constructor(private deps: SessionDeps) {}

  async run(directive: DailyDirective, ctx: MarketContext): Promise<HourlyPlan> {
    const experts: Array<{ name: string; provider: 'gpt' | 'grok'; prompt: string }> = [
      {
        name: 'analyst',
        provider: 'gpt',
        prompt: `You are a tactical crypto analyst. Given the strategic directive and current market, produce an HourlyPlan.

Directive: allowed_pairs=${directive.allowed_pairs.join(',')}, bias=${JSON.stringify(directive.pair_bias)}, risk=${directive.risk_appetite}, banned=${directive.banned_pairs.join(',')}
Market: ${JSON.stringify(ctx)}

Output JSON: { "watchlist": string[], "entry_zones": {"PAIR": {"min": number, "max": number, "bias": "long"|"short"|"neutral"}}, "position_notes": {"PAIR": "note"}, "escalate_daily": boolean, "reasoning": string }`,
      },
    ];

    if (this.deps.grok) {
      experts.push({
        name: 'challenger',
        provider: 'grok',
        prompt: `Challenge the current market view. Are there hidden risks or overlooked opportunities in crypto right now?

Allowed pairs: ${directive.allowed_pairs.join(', ')}
Market regimes: ${JSON.stringify(ctx.regimes)}
Fear & Greed: ${ctx.fearGreed.value} (${ctx.fearGreed.label})

Output JSON: { "hidden_risks": string[], "opportunities": string[], "escalate_daily": boolean, "reasoning": string }`,
      });
    }

    const results = await Promise.allSettled(
      experts.map(async (expert) => {
        const start = Date.now();
        const llm = expert.provider === 'grok' && this.deps.grok ? this.deps.grok : this.deps.llm;
        const raw = await llm.call(expert.prompt, 'Provide your analysis as JSON.');
        const latency = Date.now() - start;

        insertExpertCall({
          tier: 'tactical',
          expert_name: expert.name,
          llm_provider: expert.provider,
          result: raw,
          latency_ms: latency,
        }).catch(() => {});

        return { name: expert.name, raw };
      }),
    );

    const plan = this.aggregatePlan(results, directive);
    plan.directive_id = directive.id;
    plan.session_id = this.deps.sessionId;
    await insertHourlyPlan(plan).catch(() => {});

    console.log(`[Tactical] Plan: watchlist=${plan.watchlist.join(',')}, escalate=${plan.escalate_daily}`);
    return plan;
  }

  private aggregatePlan(
    results: PromiseSettledResult<{ name: string; raw: string }>[],
    directive: DailyDirective,
  ): HourlyPlan {
    const plan: HourlyPlan = {
      watchlist: directive.allowed_pairs.filter(p => !directive.banned_pairs.includes(p)),
      entry_zones: {},
      position_notes: {},
      escalate_daily: false,
      reasoning: '',
    };

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      try {
        const json = JSON.parse(r.value.raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        if (r.value.name === 'analyst') {
          if (json.watchlist) plan.watchlist = json.watchlist;
          if (json.entry_zones) plan.entry_zones = json.entry_zones;
          if (json.position_notes) plan.position_notes = json.position_notes;
          if (json.escalate_daily) plan.escalate_daily = true;
          if (json.reasoning) plan.reasoning = json.reasoning;
        }
        if (r.value.name === 'challenger') {
          if (json.escalate_daily) plan.escalate_daily = true;
          if (json.hidden_risks?.length > 0) {
            plan.reasoning += ` | Challenger risks: ${json.hidden_risks.join(', ')}`;
          }
        }
      } catch { /* ignore parse errors */ }
    }

    return plan;
  }
}
