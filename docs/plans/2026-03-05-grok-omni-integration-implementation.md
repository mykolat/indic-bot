# Grok Omni-Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Integrate Grok (xAI) across the entire trading pipeline, leveraging its models for narrative swarm consensus, market sentiment scanning, pre-trade risk validation (Devil's Advocate), and flash-crash prediction.

**Architecture:**
- Create a multi-model `GrokClient` capable of using `grok-4-1-fast-reasoning` (Swarm) and `grok-4-1-fast-non-reasoning` (Flash Crash).
- Extend `SwarmAgent` to use Grok as a 4th "Crowd Sentiment" voice.
- Add a `DevilAdvocateAgent` to validate high-confidence Codex trades before execution.
- Add a `FlashCrashScanner` inside the main trading loop loop that triggers a cache-dump if `non-reasoning` model detects a black swan event on X.

**Tech Stack:** TypeScript, Node.js, Vitest, xAI API.

---

### Task 1: Create the Omni `GrokClient`

**Files:**
- Create: `src/llm/grok-client.ts`
- Test: `tests/llm/grok-client.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect, vi } from 'vitest';
import { GrokClient } from '../../src/llm/grok-client.js';

describe('GrokClient', () => {
    it('calls xAI API correctly', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'Test response' } }] })
        });
        const client = new GrokClient('fake-key');
        const res = await client.call('Sys', 'User', 'grok-4-1-fast-reasoning');
        expect(res).toBe('Test response');
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.x.ai/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('grok-4-1-fast-reasoning')
            })
        );
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/grok-client.test.ts`

**Step 3: Write minimal implementation**
```typescript
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

export class GrokClient {
    constructor(private apiKey: string) {}

    async call(systemPrompt: string, userPrompt: string, model: string = 'grok-4-1-fast-reasoning'): Promise<string> {
        if (!this.apiKey) return '';
        const res = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1
            })
        }, 15000);

        if (!res.ok) throw new Error(`xAI Error: ${res.statusText}`);
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
    }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/grok-client.test.ts`

**Step 5: Commit**
```bash
git add src/llm/grok-client.ts tests/llm/grok-client.test.ts
git commit -m "feat: add generic GrokClient for xAI models #gemini"
```

---

### Task 2: Integrate Grok into Swarm Consensus

**Files:**
- Modify: `src/llm/swarm-agent.ts`
- Modify: `src/llm/prompts.ts`
- Test: `tests/llm/swarm-agent.test.ts`

**Step 1: Write the failing test**
```typescript
// Update tests/llm/swarm-agent.test.ts
// Add a mock GrokClient and verify it's called 1 time during consensus.
import { describe, it, expect, vi } from 'vitest';
import { SwarmAgent } from '../../src/llm/swarm-agent.js';
import type { LLMClient } from '../../src/llm/client.js';

describe('SwarmAgent with Grok', () => {
    it('requests consensus from both Codex and Grok', async () => {
        const mockCodex = { call: vi.fn().mockResolvedValue('Codex View') } as any;
        const mockGrok = { call: vi.fn().mockResolvedValue('Grok View') } as any;
        
        // Final analyze mock for the judge
        mockCodex.call.mockResolvedValueOnce('Codex View')
                      .mockResolvedValueOnce('Codex View')
                      .mockResolvedValueOnce('Codex View')
                      .mockResolvedValueOnce('{ "decisions": [] }');

        const agent = new SwarmAgent(mockCodex, mockGrok);
        await agent.getConsensus({} as any);

        expect(mockCodex.call).toHaveBeenCalledTimes(4); // 3 personas + 1 judge
        expect(mockGrok.call).toHaveBeenCalledTimes(1);  // 1 narrative expert
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/swarm-agent.test.ts`

**Step 3: Write minimal implementation**
*Modify `src/llm/prompts.ts`:*
Add `'narrative_expert'` to `SwarmPersona`.
Add to switch statement: `case 'narrative_expert': personaPrefix = '>>> SWARM PERSONA: You are the Crowd Sentiment Expert with live X access. Provide narrative analysis. <<<\n\n'; break;`

*Modify `src/llm/swarm-agent.ts`:*
Change constructor to `constructor(private llm: LLMClient, private grokLlm?: any) { }`.
Push 3 `this.llm.call` promises and 1 `this.grokLlm.call` promise to the `expertCalls` array.

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/swarm-agent.test.ts`

**Step 5: Commit**
```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts tests/llm/swarm-agent.test.ts
git commit -m "feat: add Grok Narrative Expert to Swarm Consensus #gemini"
```

---

### Task 3: Devil\'s Advocate Agent

**Files:**
- Create: `src/risk/devils-advocate.ts`
- Test: `tests/risk/devils-advocate.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect, vi } from 'vitest';
import { DevilsAdvocate } from '../../src/risk/devils-advocate.js';

describe('DevilsAdvocate', () => {
    it('returns veto if negative sentiment found', async () => {
        const mockGrok = {
            call: vi.fn().mockResolvedValue('{"veto": true, "reason": "Found hacked rumors on X"}')
        } as any;
        
        const advocate = new DevilsAdvocate(mockGrok);
        const res = await advocate.checkTrade('BTCUSDT', 'LONG');
        
        expect(res.veto).toBe(true);
        expect(mockGrok.call).toHaveBeenCalled();
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/risk/devils-advocate.test.ts`

**Step 3: Write minimal implementation**
```typescript
export class DevilsAdvocate {
    constructor(private grokClient: any) {}

    async checkTrade(pair: string, side: string): Promise<{ veto: boolean; reason?: string }> {
        if (!this.grokClient) return { veto: false };
        
        const sys = `You are the Devil's Advocate for crypto trades.
Your job is to search X/Twitter for any reason NOT to enter a ${side} on ${pair} right now.
Respond ONLY with JSON: { "veto": true|false, "reason": "..." }`;
        const user = `Give me a reason to NOT go ${side} on ${pair}.`;
        
        try {
            const raw = await this.grokClient.call(sys, user, 'grok-4-1-fast-reasoning');
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch(e) { /* ignore */ }
        
        return { veto: false };
    }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/risk/devils-advocate.test.ts`

**Step 5: Commit**
```bash
git add src/risk/devils-advocate.ts tests/risk/devils-advocate.test.ts
git commit -m "feat: add DevilsAdvocate agent for pre-trade risk validation #gemini"
```

---

### Task 4: Flash Crash Scanner

**Files:**
- Create: `src/news/flash-crash.ts`
- Modify: `src/trading-loop.ts` (Import and wire it up)
- Test: `tests/news/flash-crash.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect, vi } from 'vitest';
import { FlashCrashScanner } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
    it('detects panic using non-reasoning model', async () => {
        const mockGrok = {
            call: vi.fn().mockResolvedValue('PANIC')
        } as any;
        
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();
        
        expect(res).toBe('PANIC');
        expect(mockGrok.call).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), 'grok-4-1-fast-non-reasoning'
        );
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/news/flash-crash.test.ts`

**Step 3: Write minimal implementation**
```typescript
export class FlashCrashScanner {
    constructor(private grokClient: any) {}

    async scan(): Promise<'PANIC' | 'IGNORE'> {
        if (!this.grokClient) return 'IGNORE';
        
        const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".`;
        
        try {
            // Speed is critical here
            const raw = await this.grokClient.call(sys, 'Scan crypto X now.', 'grok-4-1-fast-non-reasoning');
            if (raw.trim().toUpperCase().includes('PANIC')) return 'PANIC';
        } catch(e) { /* ignore */ }
        
        return 'IGNORE';
    }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/news/flash-crash.test.ts`

**Step 5: Commit**
```bash
git add src/news/flash-crash.ts tests/news/flash-crash.test.ts
git commit -m "feat: add FlashCrashScanner using grok-4-1-fast-non-reasoning #gemini"
```
