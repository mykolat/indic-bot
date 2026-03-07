import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { AnimatePresence, motion } from 'framer-motion';

interface CycleSummaryProps {
  cycleId: number;
  cycleAge: number; // minutes
}

interface CycleDetails {
  llmCalls: { label: string | null; method: string; latency_ms: number | null }[];
  decisions: { pair: string; action: string; confidence: number; reasoning: string | null }[];
  newsAnalysis: { overall_sentiment: string; article_count: number } | null;
  macroAnalysis: { risk_level: string; summary: string | null } | null;
  riskResults: { passed: boolean; rejection_reason: string | null }[];
  executionCount: number;
  errorCount: number;
}

type StepStatus = 'ok' | 'warn' | 'error' | 'skip' | 'neutral';

interface TimelineStep {
  label: string;
  detail: string;
  status: StepStatus;
}

const statusDot: Record<StepStatus, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-yellow-400',
  error: 'bg-red-400',
  skip: 'bg-zinc-600',
  neutral: 'bg-blue-400',
};

export function CycleSummary({ cycleId, cycleAge }: CycleSummaryProps) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<CycleDetails | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || details) return;
    setLoading(true);

    Promise.all([
      supabase.from('llm_conversations').select('label, method, latency_ms')
        .eq('cycle_id', cycleId).order('created_at', { ascending: true }),
      supabase.from('trade_decisions').select('id, pair, action, confidence, reasoning')
        .eq('cycle_id', cycleId).order('created_at', { ascending: true }),
      supabase.from('news_analyses').select('overall_sentiment, article_count')
        .eq('cycle_id', cycleId).limit(1),
      supabase.from('macro_analyses').select('risk_level, summary')
        .eq('cycle_id', cycleId).limit(1),
      supabase.from('errors').select('id')
        .eq('cycle_id', cycleId),
    ]).then(async ([llm, decisions, news, macro, errors]) => {
      // Fetch risk validations and executions via decision IDs
      const decisionIds = (decisions.data ?? []).map(d => d.id);
      let riskResults: any[] = [];
      let executionCount = 0;

      if (decisionIds.length > 0) {
        const [risk, exec] = await Promise.all([
          supabase.from('risk_validations').select('passed, rejection_reason')
            .in('decision_id', decisionIds),
          supabase.from('trade_executions').select('id')
            .in('decision_id', decisionIds),
        ]);
        riskResults = risk.data ?? [];
        executionCount = exec.data?.length ?? 0;
      }

      setDetails({
        llmCalls: llm.data ?? [],
        decisions: (decisions.data ?? []).map(d => ({
          pair: d.pair, action: d.action, confidence: d.confidence,
          reasoning: d.reasoning ? d.reasoning.slice(0, 150) : null,
        })),
        newsAnalysis: news.data?.[0] ?? null,
        macroAnalysis: macro.data?.[0] ?? null,
        riskResults,
        executionCount,
        errorCount: errors.data?.length ?? 0,
      });
      setLoading(false);
    });
  }, [open, cycleId, details]);

  function buildTimeline(d: CycleDetails): TimelineStep[] {
    const steps: TimelineStep[] = [];

    // 1. Flash crash guard (always runs — if we got to LLM, it passed)
    steps.push({ label: 'Flash Crash Guard', detail: 'Passed — no panic detected', status: 'ok' });

    // 2. News
    if (d.newsAnalysis) {
      const s = d.newsAnalysis.overall_sentiment;
      steps.push({
        label: 'News Analysis',
        detail: `${d.newsAnalysis.article_count} articles — sentiment: ${s}`,
        status: s === 'bearish' || s === 'very_bearish' ? 'warn' : s === 'bullish' || s === 'very_bullish' ? 'ok' : 'neutral',
      });
    } else {
      steps.push({ label: 'News Analysis', detail: 'Skipped (cache fresh)', status: 'skip' });
    }

    // 3. Macro
    if (d.macroAnalysis) {
      const r = d.macroAnalysis.risk_level;
      steps.push({
        label: 'Macro Check',
        detail: `Risk: ${r}${d.macroAnalysis.summary ? ' — ' + d.macroAnalysis.summary.slice(0, 80) : ''}`,
        status: r === 'high' || r === 'extreme' ? 'warn' : 'ok',
      });
    } else {
      steps.push({ label: 'Macro Check', detail: 'Skipped (cache fresh)', status: 'skip' });
    }

    // 4. LLM calls
    const swarmCalls = d.llmCalls.filter(c => c.method === 'swarm');
    const analyzeCalls = d.llmCalls.filter(c => c.method === 'analyze');
    const expertCalls = d.llmCalls.filter(c => c.method === 'layer1' || c.label?.includes('expert') || c.label?.includes('Expert'));
    const otherCalls = d.llmCalls.filter(c => !['swarm', 'analyze', 'layer1'].includes(c.method) && !c.label?.includes('expert') && !c.label?.includes('Expert'));

    if (expertCalls.length > 0) {
      const avgLatency = expertCalls.reduce((s, c) => s + (c.latency_ms ?? 0), 0) / expertCalls.length;
      steps.push({
        label: 'Layer 1 Experts',
        detail: `${expertCalls.length} experts${avgLatency > 0 ? ` — avg ${(avgLatency / 1000).toFixed(1)}s` : ''}`,
        status: 'ok',
      });
    }

    if (swarmCalls.length > 0) {
      const totalLatency = swarmCalls.reduce((s, c) => s + (c.latency_ms ?? 0), 0);
      steps.push({
        label: 'Swarm Debate',
        detail: `${swarmCalls.length} persona calls${totalLatency > 0 ? ` — ${(totalLatency / 1000).toFixed(1)}s total` : ''}`,
        status: 'ok',
      });
    }

    if (analyzeCalls.length > 0) {
      const latency = analyzeCalls[0].latency_ms;
      steps.push({
        label: 'LLM Analysis',
        detail: `${analyzeCalls[0].label ?? 'Main analyst'}${latency ? ` — ${(latency / 1000).toFixed(1)}s` : ''}`,
        status: 'ok',
      });
    }

    if (otherCalls.length > 0) {
      for (const c of otherCalls) {
        steps.push({
          label: c.label ?? c.method,
          detail: c.latency_ms ? `${(c.latency_ms / 1000).toFixed(1)}s` : 'completed',
          status: 'ok',
        });
      }
    }

    if (d.llmCalls.length === 0) {
      steps.push({ label: 'LLM Analysis', detail: 'No LLM calls recorded', status: 'skip' });
    }

    // 5. Decisions
    if (d.decisions.length > 0) {
      for (const dec of d.decisions) {
        const actionColor = dec.action === 'HOLD' ? 'neutral' : dec.action === 'CLOSE' ? 'warn' : 'ok';
        steps.push({
          label: `Decision: ${dec.action} ${dec.pair}`,
          detail: `Confidence ${dec.confidence}%${dec.reasoning ? ' — ' + dec.reasoning.slice(0, 100) : ''}`,
          status: actionColor as StepStatus,
        });
      }
    } else {
      steps.push({ label: 'Decisions', detail: 'HOLD all — no action signals', status: 'neutral' });
    }

    // 6. Risk
    if (d.riskResults.length > 0) {
      const passed = d.riskResults.filter(r => r.passed).length;
      const rejected = d.riskResults.filter(r => !r.passed);
      const rejReasons = rejected.map(r => r.rejection_reason).filter(Boolean).join('; ');
      steps.push({
        label: 'Risk Validation',
        detail: `${passed} passed, ${rejected.length} rejected${rejReasons ? ' — ' + rejReasons.slice(0, 100) : ''}`,
        status: rejected.length > 0 ? 'warn' : 'ok',
      });
    }

    // 7. Execution
    if (d.executionCount > 0) {
      steps.push({
        label: 'Order Execution',
        detail: `${d.executionCount} trade${d.executionCount > 1 ? 's' : ''} placed`,
        status: 'ok',
      });
    }

    // 8. Errors
    if (d.errorCount > 0) {
      steps.push({
        label: 'Errors',
        detail: `${d.errorCount} error${d.errorCount > 1 ? 's' : ''} during cycle`,
        status: 'error',
      });
    }

    return steps;
  }

  const ageText = cycleAge < 1 ? 'just now' : cycleAge < 60 ? `${cycleAge}m ago` : `${Math.floor(cycleAge / 60)}h ${cycleAge % 60}m ago`;

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group"
      >
        <span className="font-mono">Last cycle: {ageText}</span>
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        {!open && <span className="text-zinc-600 group-hover:text-zinc-500">click to expand</span>}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 bg-surface-1 rounded-xl border border-border p-4">
              {loading && (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <div className="w-3 h-3 border-2 border-accent/40 border-t-accent rounded-full animate-spin" />
                  Loading cycle details...
                </div>
              )}

              {details && (
                <div className="space-y-0">
                  {buildTimeline(details).map((step, i, arr) => (
                    <div key={i} className="flex gap-3">
                      {/* Timeline rail */}
                      <div className="flex flex-col items-center">
                        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${statusDot[step.status]}`} />
                        {i < arr.length - 1 && <div className="w-px flex-1 bg-border min-h-[20px]" />}
                      </div>
                      {/* Content */}
                      <div className="pb-3 min-w-0">
                        <p className="text-xs font-semibold text-zinc-300 leading-tight">{step.label}</p>
                        <p className="text-[11px] text-zinc-500 leading-snug mt-0.5 break-words">{step.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
