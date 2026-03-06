# Dual-Channel Swarm Communication — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run every swarm debate in parallel across two channels (Human-Readable prose vs AI-Readable JSON protocol) and compare token usage, latency, and decision quality.

**Architecture:** Channel H runs the existing SwarmAgent (prose debate). Channel A runs a new `SwarmAgentAI` using structured JSON protocol prompts. Both get identical input data, run via `Promise.all`. Results stored in `swarm_experiments` + `swarm_experiment_results` tables. Dashboard shows toggle + Token VS comparison.

**Tech Stack:** TypeScript ESM, Vitest, Supabase (PG), React 19, Tailwind 4

**Design doc:** `docs/plans/2026-03-07-dual-channel-swarm-design.md`

**Dependency:** Execute AFTER `docs/plans/2026-03-07-swarm-chat-plan.md` (swarm chat redesign).

---

## Existing File Map

```
# Backend
src/llm/swarm-agent.ts           — SwarmAgent (human-readable debate)
src/llm/prompts.ts               — buildExpertSystemPrompt, persona prompts
src/llm/swarm-fingerprint.ts     — fingerprint dedup
src/db/types.ts                  — DB type interfaces
src/db/repository.ts             — insert functions
src/trading-loop.ts:661-663      — swarm dispatch point
tests/llm/swarm-agent.test.ts    — SwarmAgent tests

# Frontend
dashboard/src/pages/Swarm.tsx    — Swarm chat page (after chat redesign)
dashboard/src/pages/LlmCosts.tsx — LLM costs page
```

---

## Task 1: DB migration — experiment tables

**Files:**
- Modify: `src/db/types.ts` (add interfaces)
- Modify: `src/db/repository.ts` (add insert functions)

**Step 1: Apply migration via Supabase MCP**

Run SQL:

```sql
CREATE TABLE IF NOT EXISTS swarm_experiments (
  id SERIAL PRIMARY KEY,
  cycle_id INT REFERENCES cycles(id),
  channel TEXT NOT NULL CHECK (channel IN ('human', 'ai')),
  persona TEXT NOT NULL,
  phase INT DEFAULT 1,
  raw_response TEXT,
  tokens_in INT,
  tokens_out INT,
  latency_ms INT,
  decision TEXT,
  confidence INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_swarm_exp_cycle ON swarm_experiments(cycle_id);
CREATE INDEX IF NOT EXISTS idx_swarm_exp_channel ON swarm_experiments(channel);

CREATE TABLE IF NOT EXISTS swarm_experiment_results (
  id SERIAL PRIMARY KEY,
  cycle_id INT UNIQUE REFERENCES cycles(id),
  human_decision TEXT,
  ai_decision TEXT,
  same_decision BOOLEAN,
  human_tokens INT,
  ai_tokens INT,
  compression_ratio FLOAT,
  human_latency_ms INT,
  ai_latency_ms INT,
  human_levels INT,
  ai_levels INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Step 2: Add TypeScript interfaces**

Add to `src/db/types.ts`:

```typescript
export interface DbSwarmExperiment {
  id?: number;
  cycle_id?: number;
  channel: 'human' | 'ai';
  persona: string;
  phase?: number;
  raw_response?: string;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  decision?: string;
  confidence?: number;
  created_at?: string;
}

export interface DbSwarmExperimentResult {
  id?: number;
  cycle_id?: number;
  human_decision?: string;
  ai_decision?: string;
  same_decision?: boolean;
  human_tokens?: number;
  ai_tokens?: number;
  compression_ratio?: number;
  human_latency_ms?: number;
  ai_latency_ms?: number;
  human_levels?: number;
  ai_levels?: number;
  created_at?: string;
}
```

**Step 3: Add repository functions**

Add to `src/db/repository.ts`:

```typescript
export async function insertSwarmExperiment(e: Omit<DbSwarmExperiment, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO swarm_experiments (cycle_id, channel, persona, phase, raw_response, tokens_in, tokens_out, latency_ms, decision, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [e.cycle_id, e.channel, e.persona, e.phase ?? 1, e.raw_response,
     e.tokens_in, e.tokens_out, e.latency_ms, e.decision, e.confidence],
  );
  return rows[0].id;
}

export async function insertSwarmExperimentResult(r: Omit<DbSwarmExperimentResult, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO swarm_experiment_results (cycle_id, human_decision, ai_decision, same_decision, human_tokens, ai_tokens, compression_ratio, human_latency_ms, ai_latency_ms, human_levels, ai_levels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (cycle_id) DO UPDATE SET
       human_decision = EXCLUDED.human_decision,
       ai_decision = EXCLUDED.ai_decision,
       same_decision = EXCLUDED.same_decision,
       human_tokens = EXCLUDED.human_tokens,
       ai_tokens = EXCLUDED.ai_tokens,
       compression_ratio = EXCLUDED.compression_ratio,
       human_latency_ms = EXCLUDED.human_latency_ms,
       ai_latency_ms = EXCLUDED.ai_latency_ms,
       human_levels = EXCLUDED.human_levels,
       ai_levels = EXCLUDED.ai_levels
     RETURNING id`,
    [r.cycle_id, r.human_decision, r.ai_decision, r.same_decision,
     r.human_tokens, r.ai_tokens, r.compression_ratio,
     r.human_latency_ms, r.ai_latency_ms, r.human_levels, r.ai_levels],
  );
  return rows[0].id;
}
```

**Step 4: Verify bot builds**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add src/db/types.ts src/db/repository.ts
git commit -m "feat(db): add swarm_experiments + swarm_experiment_results tables"
```

---

## Task 2: AI-Readable system prompts

**Files:**
- Create: `src/llm/ai-protocol-prompts.ts`
- Test: `tests/llm/ai-protocol-prompts.test.ts`

**Step 1: Write failing tests**

Create `tests/llm/ai-protocol-prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildAIExpertPrompt, buildAIJudgePrompt, AI_PERSONA_CODES } from '../../src/llm/ai-protocol-prompts.js';

describe('AI protocol prompts', () => {
  it('expert prompt instructs JSON-only output with required fields', () => {
    const prompt = buildAIExpertPrompt('risk_manager');
    expect(prompt).toContain('"p"');
    expect(prompt).toContain('"d"');
    expect(prompt).toContain('"prob"');
    expect(prompt).toContain('"thesis"');
    expect(prompt).toContain('"args"');
    expect(prompt).toContain('"risks"');
    expect(prompt).toContain('JSON');
    expect(prompt).not.toContain('sentence');
    expect(prompt).not.toContain('paragraph');
  });

  it('expert prompt includes persona-specific role for risk_manager', () => {
    const prompt = buildAIExpertPrompt('risk_manager');
    expect(prompt).toContain('RM');
    expect(prompt).toContain('risk');
  });

  it('level 2+ prompt includes contra field instruction', () => {
    const history = [
      { p: 'BT', d: 'LONG', prob: 75, thesis: 'ema_bounce' },
    ];
    const prompt = buildAIExpertPrompt('devils_advocate', history);
    expect(prompt).toContain('"contra"');
    expect(prompt).toContain('BT');
  });

  it('judge prompt requests continue/decisions JSON', () => {
    const history = [
      { p: 'RM', d: 'HOLD', prob: 30, thesis: 'liq_risk' },
      { p: 'DA', d: 'LONG', prob: 55, thesis: 'crowded_short' },
    ];
    const prompt = buildAIJudgePrompt(1, history);
    expect(prompt).toContain('"continue"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"verdict"');
  });

  it('persona codes map correctly', () => {
    expect(AI_PERSONA_CODES.risk_manager).toBe('RM');
    expect(AI_PERSONA_CODES.bull_thesis).toBe('BT');
    expect(AI_PERSONA_CODES.devils_advocate).toBe('DA');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/llm/ai-protocol-prompts.test.ts
```
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/llm/ai-protocol-prompts.ts`:

```typescript
import type { SwarmPersona } from './prompts.js';

export const AI_PERSONA_CODES: Record<string, string> = {
  risk_manager: 'RM',
  bull_thesis: 'BT',
  bear_thesis: 'BA',
  market_structure: 'MS',
  devils_advocate: 'DA',
  narrative_expert: 'NE',
};

const PERSONA_ROLES: Record<string, string> = {
  risk_manager: 'RISK: find reasons NOT to trade. Focus: liq_risk, leverage, drawdown, sl_adequacy',
  bull_thesis: 'BULL: argue bullish case. Focus: momentum, breakout, support_hold, catalyst',
  bear_thesis: 'BEAR: argue bearish case. Focus: overbought, divergence, resistance, macro_headwind',
  market_structure: 'STRUCT: microstructure analysis. Focus: funding, oi, ls_ratio, orderbook, liq_zones',
  devils_advocate: 'CONTRA: argue OPPOSITE of consensus. Find: crowded_trade, hidden_risk, reversal_signal',
  narrative_expert: 'NARR: crowd sentiment. Focus: ct_narrative, positioning, influencer_calls, sentiment_divergence',
};

interface AIMessage {
  p: string;
  d: string;
  prob: number;
  thesis: string;
  [key: string]: unknown;
}

export function buildAIExpertPrompt(persona: SwarmPersona, priorMessages?: AIMessage[]): string {
  const code = AI_PERSONA_CODES[persona] ?? persona.slice(0, 2).toUpperCase();
  const role = PERSONA_ROLES[persona] ?? 'ANALYST';

  let prompt = `ROLE: ${role}
CODE: ${code}

PROTOCOL: AI-to-AI structured JSON. NO prose. NO explanation. ONLY valid JSON.

OUTPUT FORMAT:
{"p":"${code}","d":"HOLD|LONG|SHORT|CLOSE","prob":<0-100>,"c":<0-100>,"thesis":"<slug>","args":["<tag1>","<tag2>"],"risks":["<risk1>"],"ctx":"<market_context_slug>"}

RULES:
- "thesis": max 5 words, underscore-separated slug
- "args": max 5 items, each max 3 words
- "risks": max 3 items, each max 3 words
- "ctx": single slug summarizing market state
- "prob": probability_of_success for YOUR position
- NO natural language. Tags and slugs only.`;

  if (priorMessages && priorMessages.length > 0) {
    prompt += `

PRIOR MESSAGES:
${priorMessages.map(m => JSON.stringify(m)).join('\n')}

ADD "contra" FIELD: reference specific args/risks from other personas you disagree with.
Format: ["<CODE>.<field>.<value>→<your_counter>"]
Example: ["BT.thesis.ema_bounce→false_breakout_low_vol"]`;
  }

  return prompt;
}

export function buildAIJudgePrompt(
  level: number,
  history: AIMessage[],
  maxLevels: number = 5,
): string {
  const isLast = level >= maxLevels;

  return `ROLE: SWARM JUDGE. Level ${level}/${maxLevels}.

MESSAGES:
${history.map(m => JSON.stringify(m)).join('\n')}

OUTPUT FORMAT:
{"continue":${isLast ? 'false' : 'true|false'},"verdict":"<slug>","next_speakers":["<CODE>"],"decisions":[{"pair":"<PAIR>","d":"HOLD|LONG|SHORT|CLOSE","c":<0-100>}],"next_check_minutes":<1-30>}

RULES:
- continue=true: disagreement unresolved, need more rounds. decisions=[]
- continue=false: consensus reached OR final level. decisions MUST have entries.
- next_speakers: only if continue=true. Who should speak next.
- verdict: max 5 words slug.
- ONLY valid JSON. NO prose.`;
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/llm/ai-protocol-prompts.test.ts
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/ai-protocol-prompts.ts tests/llm/ai-protocol-prompts.test.ts
git commit -m "feat(swarm): AI-readable protocol prompts — structured JSON format for machine-to-machine debate"
```

---

## Task 3: SwarmAgentAI class — AI-readable debate runner

**Files:**
- Create: `src/llm/swarm-agent-ai.ts`
- Test: `tests/llm/swarm-agent-ai.test.ts`

**Step 1: Write failing tests**

Create `tests/llm/swarm-agent-ai.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SwarmAgentAI } from '../../src/llm/swarm-agent-ai.js';
import type { EnrichedPromptData } from '../../src/llm/prompts.js';

const makeMinimalPromptData = (): EnrichedPromptData => ({
  snapshots: [],
  indicators: new Map(),
  portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] },
  signals: [],
  news: [],
  fearGreed: { value: 50, label: 'Neutral' },
});

const aiExpertResponse = JSON.stringify({
  p: 'RM', d: 'HOLD', prob: 30, c: 90,
  thesis: 'liq_risk_high', args: ['funding_0.03', 'oi_ath'], risks: ['squeeze'], ctx: '4h_bear',
});

const aiJudgeStop = JSON.stringify({
  continue: false, verdict: 'consensus_hold',
  decisions: [{ pair: 'BTCUSDT', d: 'HOLD', c: 45 }],
  next_check_minutes: 15,
});

describe('SwarmAgentAI', () => {
  it('runs AI-readable debate and returns decisions + metrics', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(aiExpertResponse);
        return Promise.resolve(aiJudgeStop);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgentAI(mockLlm);
    const result = await agent.runDebate(makeMinimalPromptData());

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].d).toBe('HOLD');
    expect(result.totalTokensIn).toBeGreaterThanOrEqual(0);
    expect(result.totalTokensOut).toBeGreaterThanOrEqual(0);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.levels).toBe(1);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('returns messages with persona codes', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(aiExpertResponse);
        return Promise.resolve(aiJudgeStop);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgentAI(mockLlm);
    const result = await agent.runDebate(makeMinimalPromptData());

    const personaCodes = result.messages.filter(m => m.persona !== 'judge').map(m => m.persona);
    expect(personaCodes).toContain('RM');
  });
});
```

**Step 2: Run tests to verify fail**

```bash
npx vitest run tests/llm/swarm-agent-ai.test.ts
```

**Step 3: Implement SwarmAgentAI**

Create `src/llm/swarm-agent-ai.ts`:

```typescript
import type { LLMClient } from './client.js';
import type { EnrichedPromptData, SwarmPersona } from './prompts.js';
import { buildUserPrompt } from './prompts.js';
import { buildAIExpertPrompt, buildAIJudgePrompt, AI_PERSONA_CODES } from './ai-protocol-prompts.js';

interface AIMessage {
  p: string;
  d: string;
  prob: number;
  c?: number;
  thesis: string;
  args?: string[];
  risks?: string[];
  ctx?: string;
  contra?: string[];
  [key: string]: unknown;
}

export interface AIDebateResult {
  decisions: Array<{ pair: string; d: string; c: number; [key: string]: unknown }>;
  messages: Array<{ persona: string; content: string; phase: number; decision?: string; confidence?: number }>;
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
  levels: number;
}

export class SwarmAgentAI {
  constructor(private llm: LLMClient, private grokLlm?: any) {}

  async runDebate(data: EnrichedPromptData): Promise<AIDebateResult> {
    const userPrompt = buildUserPrompt(data);
    const MAX_LEVELS = 5;
    const allHistory: AIMessage[] = [];
    const allMessages: AIDebateResult['messages'] = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalLatencyMs = 0;

    const allPersonas: SwarmPersona[] = ['risk_manager', 'market_structure', 'devils_advocate'];
    if (this.grokLlm) allPersonas.push('narrative_expert');

    let finalDecisions: AIDebateResult['decisions'] = [];
    let nextSpeakers: string[] | undefined;

    for (let level = 1; level <= MAX_LEVELS; level++) {
      const speakers = level === 1
        ? allPersonas
        : (nextSpeakers ?? allPersonas).map(code => {
            // Resolve code back to persona name
            const entry = Object.entries(AI_PERSONA_CODES).find(([, c]) => c === code);
            return (entry ? entry[0] : code) as SwarmPersona;
          });

      const priorForPrompt = level > 1 ? allHistory : undefined;

      const expertCalls = speakers.map(p => {
        const isGrok = p === 'narrative_expert' && this.grokLlm;
        const llm = isGrok ? this.grokLlm : this.llm;
        const start = Date.now();
        const model = isGrok ? 'grok-4-1-fast-reasoning' : undefined;
        return llm.call(
          buildAIExpertPrompt(p as SwarmPersona, priorForPrompt),
          userPrompt,
          ...(model ? [model] : []),
        ).then((raw: string) => ({
          raw,
          persona: p,
          latency: Date.now() - start,
        }));
      });

      const results = await Promise.allSettled(expertCalls);

      for (const res of results) {
        if (res.status !== 'fulfilled') continue;
        const { raw, persona, latency } = res.value;
        totalLatencyMs += latency;

        let parsed: AIMessage | null = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const match = raw.match(/\{[^}]*"p"[^}]*\}/);
          if (match) try { parsed = JSON.parse(match[0]); } catch { /* */ }
        }

        const code = AI_PERSONA_CODES[persona] ?? persona;

        if (parsed) {
          allHistory.push(parsed);
          allMessages.push({
            persona: code,
            content: raw,
            phase: level,
            decision: parsed.d,
            confidence: parsed.c,
          });
        } else {
          allMessages.push({ persona: code, content: raw, phase: level });
        }
      }

      // Judge
      const judgeStart = Date.now();
      let rawJudge: string;
      try {
        rawJudge = await this.llm.call(buildAIJudgePrompt(level, allHistory, MAX_LEVELS), userPrompt);
      } catch {
        break;
      }
      totalLatencyMs += Date.now() - judgeStart;

      allMessages.push({ persona: 'judge', content: rawJudge, phase: level });

      let judgeResult: any;
      try {
        judgeResult = JSON.parse(rawJudge);
      } catch {
        const match = rawJudge.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
        if (match) try { judgeResult = JSON.parse(match[0]); } catch { /* */ }
      }

      if (!judgeResult) break;

      if (!judgeResult.continue || level >= MAX_LEVELS) {
        finalDecisions = judgeResult.decisions || [];
        break;
      }

      nextSpeakers = judgeResult.next_speakers;
    }

    return {
      decisions: finalDecisions,
      messages: allMessages,
      totalTokensIn,
      totalTokensOut,
      totalLatencyMs,
      levels: Math.max(...allMessages.map(m => m.phase), 1),
    };
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/llm/swarm-agent-ai.test.ts
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-agent-ai.ts tests/llm/swarm-agent-ai.test.ts
git commit -m "feat(swarm): SwarmAgentAI class — AI-readable debate runner with JSON protocol"
```

---

## Task 4: Wire parallel execution in TradingLoop

**Files:**
- Modify: `src/trading-loop.ts:661-663` (add parallel AI channel)
- Modify: `src/index.ts` (instantiate SwarmAgentAI)

**Step 1: Add SwarmAgentAI to TradingLoop deps**

In `src/trading-loop.ts`, add to the deps interface:

```typescript
swarmAgentAI?: SwarmAgentAI;
```

And add import:

```typescript
import { SwarmAgentAI } from './llm/swarm-agent-ai.js';
```

**Step 2: Run both channels in parallel**

Replace the swarm dispatch block at line 661-663:

```typescript
if (useSwarm && this.deps.swarmAgent) {
  console.log(`[Loop] High Volatility (Vol=${btcInd?.volumeRatio.toFixed(1)}x) -> Engaging SWARM CONSENSUS`);

  // Run both channels in parallel
  const humanPromise = this.deps.swarmAgent.getConsensus(promptData);
  const aiPromise = this.deps.swarmAgentAI
    ? this.deps.swarmAgentAI.runDebate(promptData).catch(err => {
        console.warn('[Loop] AI-channel swarm failed (non-critical):', err.message);
        return null;
      })
    : Promise.resolve(null);

  const [humanDecisions, aiResult] = await Promise.all([humanPromise, aiPromise]);
  decisions = humanDecisions; // Human channel = production

  // Log experiment comparison
  if (aiResult) {
    const humanDec = decisions[0]?.action ?? 'NONE';
    const aiDec = aiResult.decisions[0]?.d ?? 'NONE';
    const sameDec = humanDec === aiDec;
    console.log(`[Swarm Experiment] Human: ${humanDec} | AI: ${aiDec} | Same: ${sameDec} | AI tokens: ${aiResult.totalTokensOut}`);

    // Store experiment results (fire-and-forget)
    import('./db/repository.js').then(({ insertSwarmExperimentResult }) => {
      insertSwarmExperimentResult({
        cycle_id: cycleId,
        human_decision: humanDec,
        ai_decision: aiDec,
        same_decision: sameDec,
        human_tokens: 0, // TODO: track from human channel
        ai_tokens: aiResult.totalTokensOut,
        compression_ratio: 0, // computed after we track human tokens
        human_latency_ms: 0,
        ai_latency_ms: aiResult.totalLatencyMs,
        human_levels: 1,
        ai_levels: aiResult.levels,
      }).catch(() => {});
    }).catch(() => {});
  }
}
```

**Step 3: Instantiate SwarmAgentAI in src/index.ts**

Add near where SwarmAgent is created:

```typescript
import { SwarmAgentAI } from './llm/swarm-agent-ai.js';

// After SwarmAgent creation:
const swarmAgentAI = new SwarmAgentAI(llmClient, grokClient);
```

Pass it to TradingLoop deps:

```typescript
swarmAgentAI,
```

**Step 4: Verify bot builds**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add src/trading-loop.ts src/index.ts
git commit -m "feat(swarm): wire parallel AI-channel debate in TradingLoop"
```

---

## Task 5: Dashboard — channel toggle + Token VS widget

**Files:**
- Create: `dashboard/src/components/swarm/TokenVsWidget.tsx`
- Modify: `dashboard/src/pages/Swarm.tsx` (add toggle + widget)

**Step 1: Create TokenVsWidget component**

Create `dashboard/src/components/swarm/TokenVsWidget.tsx`:

```tsx
interface TokenVsWidgetProps {
  humanTokens: number;
  aiTokens: number;
  sameDecision: boolean;
  humanDecision: string;
  aiDecision: string;
}

export function TokenVsWidget({ humanTokens, aiTokens, sameDecision, humanDecision, aiDecision }: TokenVsWidgetProps) {
  const savings = humanTokens > 0 ? Math.round((1 - aiTokens / humanTokens) * 100) : 0;
  const maxTokens = Math.max(humanTokens, aiTokens, 1);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase">Token Comparison</h3>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 w-16">Human</span>
          <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-blue-500 rounded" style={{ width: `${(humanTokens / maxTokens) * 100}%` }} />
          </div>
          <span className="text-xs font-mono text-zinc-400 w-16 text-right">{humanTokens.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 w-16">AI</span>
          <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-amber-500 rounded" style={{ width: `${(aiTokens / maxTokens) * 100}%` }} />
          </div>
          <span className="text-xs font-mono text-zinc-400 w-16 text-right">{aiTokens.toLocaleString()}</span>
        </div>
      </div>

      <div className="flex justify-between text-xs">
        <span className="text-zinc-500">
          Savings: <span className="text-amber-400 font-mono">{savings}%</span>
        </span>
        <span className="text-zinc-500">
          Same decision: <span className={sameDecision ? 'text-green-400' : 'text-red-400'}>
            {sameDecision ? 'YES' : 'NO'} ({humanDecision} vs {aiDecision})
          </span>
        </span>
      </div>
    </div>
  );
}
```

**Step 2: Add channel toggle and experiment data to Swarm.tsx**

In `dashboard/src/pages/Swarm.tsx`, add state and data fetching:

```tsx
const [channel, setChannel] = useState<'human' | 'ai'>('human');
const [experimentResult, setExperimentResult] = useState<any>(null);

// Fetch experiment result for current debate's cycle
useEffect(() => {
  if (!current) return;
  supabase
    .from('swarm_experiment_results')
    .select('*')
    .eq('cycle_id', current.cycleId)
    .single()
    .then(({ data }) => setExperimentResult(data));
}, [current?.cycleId]);

// Fetch AI-channel messages when in AI mode
const [aiMessages, setAiMessages] = useState<SwarmMessage[]>([]);
useEffect(() => {
  if (channel !== 'ai' || !current) return;
  supabase
    .from('swarm_experiments')
    .select('persona, raw_response, phase, decision, confidence, latency_ms, created_at')
    .eq('cycle_id', current.cycleId)
    .eq('channel', 'ai')
    .order('created_at', { ascending: true })
    .then(({ data }) => {
      if (!data) return;
      setAiMessages(data.map(d => ({
        persona: d.persona,
        content: d.raw_response || '',
        vote: d.decision,
        confidence: d.confidence,
        time: new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        phase: d.phase ?? 1,
        isJudge: d.persona === 'judge',
      })));
    });
}, [channel, current?.cycleId]);
```

Add toggle buttons in the chat header:

```tsx
<div className="flex gap-1 ml-auto">
  {['human', 'ai'].map((ch) => (
    <button
      key={ch}
      onClick={() => setChannel(ch as 'human' | 'ai')}
      className={`text-xs px-3 py-1 rounded ${
        channel === ch ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-white'
      }`}
    >
      {ch === 'human' ? 'Human' : 'AI'}
    </button>
  ))}
</div>
```

Render appropriate messages based on channel:

```tsx
const messagesToRender = channel === 'ai' ? aiMessages : current.messages;
```

Add TokenVsWidget below chat messages (above superuser input):

```tsx
{experimentResult && (
  <TokenVsWidget
    humanTokens={experimentResult.human_tokens ?? 0}
    aiTokens={experimentResult.ai_tokens ?? 0}
    sameDecision={experimentResult.same_decision ?? false}
    humanDecision={experimentResult.human_decision ?? '—'}
    aiDecision={experimentResult.ai_decision ?? '—'}
  />
)}
```

**Step 3: Verify dashboard builds**

```bash
cd dashboard && npm run build
```

**Step 4: Commit**

```bash
git add dashboard/src/components/swarm/TokenVsWidget.tsx dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): add channel toggle + Token VS widget for swarm experiment"
```

---

## Task 6: Experiment metrics on LLM Costs page

**Files:**
- Modify: `dashboard/src/pages/LlmCosts.tsx` (add experiment summary section)

**Step 1: Add experiment stats**

In `dashboard/src/pages/LlmCosts.tsx`, add a new section that fetches aggregate experiment data:

```tsx
const [expStats, setExpStats] = useState<{ total: number; agreed: number; avgCompression: number; avgSavings: number } | null>(null);

useEffect(() => {
  supabase.from('swarm_experiment_results').select('same_decision, human_tokens, ai_tokens, compression_ratio').then(({ data }) => {
    if (!data || data.length === 0) return;
    const total = data.length;
    const agreed = data.filter(d => d.same_decision).length;
    const totalH = data.reduce((s, d) => s + (d.human_tokens ?? 0), 0);
    const totalA = data.reduce((s, d) => s + (d.ai_tokens ?? 0), 0);
    const avgSavings = totalH > 0 ? Math.round((1 - totalA / totalH) * 100) : 0;
    const avgCompression = data.filter(d => d.compression_ratio).reduce((s, d) => s + d.compression_ratio!, 0) / Math.max(data.filter(d => d.compression_ratio).length, 1);
    setExpStats({ total, agreed, avgCompression: Math.round(avgCompression * 10) / 10, avgSavings });
  });
}, []);
```

Render below existing charts:

```tsx
{expStats && expStats.total > 0 && (
  <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
    <h3 className="text-sm font-semibold text-zinc-300 mb-4">Swarm Experiment: Human vs AI Protocol</h3>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div>
        <div className="text-zinc-500 text-xs">Experiments</div>
        <div className="text-xl font-mono font-bold">{expStats.total}</div>
      </div>
      <div>
        <div className="text-zinc-500 text-xs">Agreement Rate</div>
        <div className="text-xl font-mono font-bold text-green-400">
          {Math.round((expStats.agreed / expStats.total) * 100)}%
        </div>
      </div>
      <div>
        <div className="text-zinc-500 text-xs">Token Savings</div>
        <div className="text-xl font-mono font-bold text-amber-400">{expStats.avgSavings}%</div>
      </div>
      <div>
        <div className="text-zinc-500 text-xs">Compression Ratio</div>
        <div className="text-xl font-mono font-bold">{expStats.avgCompression}x</div>
      </div>
    </div>
  </div>
)}
```

**Step 2: Verify build**

```bash
cd dashboard && npm run build
```

**Step 3: Commit**

```bash
git add dashboard/src/pages/LlmCosts.tsx
git commit -m "feat(dashboard): add swarm experiment stats to LLM Costs page"
```

---

## Task Summary

| Task | What | Domain | Effort |
|------|------|--------|--------|
| 1 | DB tables + repository functions | Backend/DB | Small |
| 2 | AI-readable protocol prompts + tests | Backend | Medium |
| 3 | SwarmAgentAI class + tests | Backend | Medium |
| 4 | Wire parallel execution in TradingLoop | Backend | Small |
| 5 | Dashboard: channel toggle + Token VS widget | Frontend | Medium |
| 6 | Experiment stats on LLM Costs page | Frontend | Small |

**Total LLM calls per swarm cycle with experiment**: ~8-14 (Human: 4-7, AI: 4-7 in parallel).
**Data collected per cycle**: token counts, latency, decision comparison, level counts.
