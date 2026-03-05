# Swarm Consensus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Implement "Swarm Consensus" (Phase 1 of AI Architectural Innovations roadmap) to dynamically deploy specialized sub-agents during high volatility and force a consensus decision for higher conviction entries.

**Architecture:** We will create a `SwarmAgent` that wraps the `LLMClient`. During the `TradingLoop`, if volatility (ATR or Volume) is high, instead of a single LLM call, the loop will invoke `SwarmAgent.getConsensus()`. This will run 3 distinct prompt variations (Permabull, Permabear, Risk Manager) in parallel using `Promise.allSettled`, then feed their outputs into a final "Consensus Judge" LLM call to output the final `TradeDecision`.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Create the Swarm Prompts

**Files:**
- Modify: `src/llm/prompts.ts`
- Test: `tests/llm/prompts.test.ts`

**Step 1: Write the failing test**
In `tests/llm/prompts.test.ts`, add a test for the new swarm persona generator:
```typescript
import { buildSwarmPersonaPrompt, buildConsensusPrompt } from '../../src/llm/prompts.js';

describe('Swarm Prompts', () => {
    it('builds persona specific system prompts', () => {
        const bull = buildSwarmPersonaPrompt('permabull');
        expect(bull).toContain('You are an ultra-aggressive PERMABULL');
        expect(bull).toContain('MULTI-TIMEFRAME CONFIRMATION'); // inherits base rules
        
        const bear = buildSwarmPersonaPrompt('permabear');
        expect(bear).toContain('You are an ultra-aggressive PERMABEAR');
        
        const risk = buildSwarmPersonaPrompt('paranoid_risk_manager');
        expect(risk).toContain('You are a PARANOID RISK MANAGER');
    });

    it('builds consensus prompt', () => {
        const prompt = buildConsensusPrompt(['bull says long', 'bear says short', 'risk says hold']);
        expect(prompt).toContain('You are the SWARM CONSENSUS JUDGE');
        expect(prompt).toContain('bull says long');
        expect(prompt).toContain('bear says short');
        expect(prompt).toContain('Respond ONLY with valid JSON');
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/prompts.test.ts -t "Swarm Prompts"`

**Step 3: Write minimal implementation**
In `src/llm/prompts.ts`, add:
```typescript
export type SwarmPersona = 'permabull' | 'permabear' | 'paranoid_risk_manager';

export function buildSwarmPersonaPrompt(persona: SwarmPersona, config?: Parameters<typeof buildSystemPrompt>[0]): string {
    const basePrompt = buildSystemPrompt(config || {
        targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5
    });

    let personaPrefix = '';
    switch (persona) {
        case 'permabull':
            personaPrefix = `>>> SWARM PERSONA: You are an ultra-aggressive PERMABULL. You look for any excuse to go LONG. You ignore bearish signals unless absolutely catastrophic. <<<\n\n`;
            break;
        case 'permabear':
            personaPrefix = `>>> SWARM PERSONA: You are an ultra-aggressive PERMABEAR. You look for any excuse to go SHORT. You ignore bullish signals unless absolutely undeniable. <<<\n\n`;
            break;
        case 'paranoid_risk_manager':
            personaPrefix = `>>> SWARM PERSONA: You are a PARANOID RISK MANAGER. Your only goal is capital preservation. You look for any excuse to HOLD or CLOSE. You only approve entries if the setup is mathematically flawless. <<<\n\n`;
            break;
    }

    return personaPrefix + basePrompt;
}

export function buildConsensusPrompt(expertDecisions: string[], config?: Parameters<typeof buildSystemPrompt>[0]): string {
    const basePrompt = buildSystemPrompt(config || {
        targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5
    });
    
    // We replace the persona intro with the judge persona
    const judgePrompt = basePrompt.replace(
        /You are an aggressive crypto futures trader managing a LIVE account with real money\./,
        `You are the SWARM CONSENSUS JUDGE managing a LIVE account with real money. You must objectively weigh the conflicting opinions of your sub-agents and make the final, most rational decision.`
    );

    let prompt = `${judgePrompt}\n\n## Sub-Agent Opinions for Current Cycle\n\n`;
    expertDecisions.forEach((dec, i) => {
        prompt += `### Expert ${i + 1}\n${dec}\n\n`;
    });

    prompt += `Analyze the expert opinions. If they strongly disagree, lean towards HOLD. If two agree, lean towards their consensus if rationally justified.\n`;
    return prompt;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/prompts.test.ts -t "Swarm Prompts"`

**Step 5: Commit**
```bash
git add src/llm/prompts.ts tests/llm/prompts.test.ts
git commit -m "feat: add swarm persona and consensus prompts #gemini"
```

---

### Task 2: Create the SwarmAgent

**Files:**
- Create: `src/llm/swarm-agent.ts`
- Create: `tests/llm/swarm-agent.test.ts`

**Step 1: Write the failing test**
In `tests/llm/swarm-agent.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { SwarmAgent } from '../../src/llm/swarm-agent.js';
import type { TradeDecision } from '../../src/risk/manager.js';

describe('SwarmAgent', () => {
    it('runs 3 personas and a consensus maker', async () => {
        const mockRawCall = vi.fn().mockResolvedValue('{"decisions": [{"pair": "BTCUSDT", "action": "HOLD"}], "next_check_minutes": 10}');
        const mockLlm = {
            call: mockRawCall,
            analyze: vi.fn(), // Not used by SwarmAgent directly
            model: 'test-model',
            lastNextCheckMinutes: undefined
        } as any;

        const agent = new SwarmAgent(mockLlm);
        const decisions = await agent.getConsensus({ snapshots: [], indicators: new Map(), portfolio: { balanceUsd: 100, availableUsd: 100, sessionPnl: 0, positions: [] }, signals: [], news: [], fearGreed: { value: 50, label: 'Neutral' } });

        expect(mockRawCall).toHaveBeenCalledTimes(4); // 3 personas + 1 consensus
        expect(decisions).toHaveLength(1);
        expect(decisions[0].action).toBe('HOLD');
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/swarm-agent.test.ts`

**Step 3: Write minimal implementation**
In `src/llm/swarm-agent.ts`:
```typescript
import type { LLMClient } from './client.js';
import type { TradeDecision } from '../risk/manager.js';
import { buildUserPrompt, type EnrichedPromptData, buildSwarmPersonaPrompt, buildConsensusPrompt, type SwarmPersona } from './prompts.js';

export class SwarmAgent {
    constructor(private llm: LLMClient) {}

    async getConsensus(data: EnrichedPromptData): Promise<TradeDecision[]> {
        const userPrompt = buildUserPrompt(data);
        
        console.log('[Swarm] Waking up sub-agents (Bull, Bear, RiskManager)...');
        
        const personas: SwarmPersona[] = ['permabull', 'permabear', 'paranoid_risk_manager'];
        const expertCalls = personas.map(p => this.llm.call(buildSwarmPersonaPrompt(p), userPrompt));
        
        const results = await Promise.allSettled(expertCalls);
        const expertDecisions: string[] = [];
        
        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            if (res.status === 'fulfilled') {
                expertDecisions.push(`[${personas[i].toUpperCase()}]:\n${res.value}`);
            } else {
                console.warn(`[Swarm] Sub-agent ${personas[i]} failed:`, res.reason);
            }
        }

        if (expertDecisions.length === 0) {
            console.error('[Swarm] All sub-agents failed, aborting consensus.');
            throw new Error('Swarm failure');
        }

        console.log(`[Swarm] Aggregating ${expertDecisions.length} opinions. Synthesizing consensus...`);
        const consensusPrompt = buildConsensusPrompt(expertDecisions);
        
        // Use the LLMClient's analyze method for the final call to get valid parsed JSON
        // but we need to override the system prompt for that specific call.
        // Since LLMClient.analyze doesn't accept a system prompt override easily, we'll use .call 
        // and parse it manually exactly like LLMClient does.
        
        const rawConsensus = await this.llm.call(consensusPrompt, userPrompt);
        
        let jsonMatch = rawConsensus.match(/\{[^{}]*"decisions"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/);
        if (!jsonMatch) jsonMatch = rawConsensus.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
        
        if (!jsonMatch) {
            console.error('[Swarm] Consensus parser failed to find JSON');
            return [];
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            this.llm.lastNextCheckMinutes = parsed.next_check_minutes;
            return parsed.decisions || [];
        } catch (e) {
            console.error('[Swarm] Consensus JSON invalid', e);
            return [];
        }
    }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/swarm-agent.test.ts`

**Step 5: Commit**
```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat: implement SwarmAgent for parallel consensus decisions #gemini"
```

---

### Task 3: Integrate SwarmAgent into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/index.ts`
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**
In `tests/trading-loop.test.ts`, add a test to ensure the swarm is triggered on high volatility:
```typescript
    it('uses swarm agent when volume ratio > 1.5 in layer 1', async () => {
        const mockSwarmConsensus = vi.fn().mockResolvedValue([{ pair: 'BTCUSDT', action: 'HOLD' }]);
        
        // We need to inject SwarmAgent into loop dependencies
        const mockSwarmAgent = { getConsensus: mockSwarmConsensus };
        
        const loopWithSwarm = new TradingLoop({
            ...mockDeps,
            swarmAgent: mockSwarmAgent as any
        });

        // Set high volume 
        mockDeps.marketData.getSnapshot = vi.fn().mockResolvedValue({
            ...mockDeps.marketData.getSnapshot(),
            candles1h: Array(24).fill({ close: '60000', high: '61000', low: '59000', volume: '200' }) // 200 > 100 avg -> 2x volume
        });
        // We need to mock Technical indicators to return volume = 2.0
        // (Assuming the test setup mocks processIndicators)
        // If not, we just rely on the TradingLoop finding volumeRatio > 1.5 in the indicators map.

        // Force technical analyzer to return high volume
        vi.spyOn(await import('../../src/indicators/technical.js'), 'processIndicators').mockReturnValue({
            rsi: 50, ema20: 50, ema50: 50, atr: 10, vwap: 50, volumeRatio: 2.0, trend: 'neutral',
            macd: 0, macdSignal: 0, macdHistogram: 0, bollingerUpper: 100, bollingerMiddle: 50, bollingerLower: 0, bollingerPercentB: 50, bollingerBandwidth: 10, adx: 20
        });

        await loopWithSwarm.runOnce();

        expect(mockSwarmConsensus).toHaveBeenCalled();
        expect(mockDeps.llm.analyze).not.toHaveBeenCalled();
    });
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/trading-loop.test.ts -t "uses swarm agent"`

**Step 3: Write minimal implementation**
In `src/trading-loop.ts`, update `TradingLoopDeps`:
```typescript
import type { SwarmAgent } from './llm/swarm-agent.js';
// ... inside interface TradingLoopDeps:
  swarmAgent?: SwarmAgent;
```

Update `runOnce()` around line 433 (where `llm.analyze` is called):
```typescript
        if (filterWarning) {
          console.log(`[Loop] Pre-flight warning: ${filterWarning} (Passing to LLM as Soft Filter)`);
          logger.logError('LLM_PREFLIGHT_WARNING', filterWarning);
        }

        // SWARM TRIGGER: If volume is high (>1.5x) or ATR spiked, invoke Swarm Consensus
        let useSwarm = false;
        if (this.deps.swarmAgent && btcInd) {
            const btcSnapTemp = snapshots.find(s => s.pair === 'BTCUSDT');
            if (btcSnapTemp) {
                const btcIndTemp = indicators.get(btcSnapTemp.pair);
                if (btcIndTemp && btcIndTemp.volumeRatio > 1.5) {
                    useSwarm = true;
                }
            }
        }

        if (useSwarm && this.deps.swarmAgent) {
            console.log(`[Loop] High Volatility (Vol=${btcInd?.volumeRatio.toFixed(1)}x) -> Engaging SWARM CONSENSUS`);
            decisions = await this.deps.swarmAgent.getConsensus(promptData);
            // Copy check minutes to main LLM so the outer loop picks it up
            llm.lastNextCheckMinutes = promptData.next_check_minutes || 5; 
        } else {
            decisions = await llm.analyze(promptData);
        }
```

In `src/index.ts`, instantiate and inject it:
```typescript
import { SwarmAgent } from './llm/swarm-agent.js';
// ... after llm setup:
const swarmAgent = new SwarmAgent(llm);

// ... in new TradingLoop:
  swarmAgent,
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/trading-loop.test.ts -t "uses swarm agent"`

**Step 5: Commit**
```bash
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat: integrate SwarmAgent into TradingLoop for high volatility regimes #gemini"
```
