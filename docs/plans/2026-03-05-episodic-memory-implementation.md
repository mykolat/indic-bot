# Phase 2: Episodic Memory (Graph RAG) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Implement a Graph RAG system using Text Embeddings and a Local JSON storage to provide the bot with semantic episodic memory of past market scenarios and trade outcomes.

**Architecture:** We will create a local memory graph (`data/memory-graph.json`) to store episodic memories. We will add an `EmbeddingClient` to interact with OpenAI's `text-embedding-3-small` model. An `ExtractionAgent` will parse closed trades to create new memory nodes (episodes). A `RAGAgent` will retrieve the most similar past episodes (using cosine similarity) prior to generating prompts for the main agent, injecting this context to improve decision-making.

**Tech Stack:** TypeScript, Node.js, Vitest, OpenAI Embeddings (`text-embedding-3-small`).

---

### Task 1: Create the EmbeddingClient

**Files:**
- Create: `src/llm/embedding-client.ts`
- Create: `tests/llm/embedding-client.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect, vi } from 'vitest';
import { EmbeddingClient, cosineSimilarity } from '../../src/llm/embedding-client.js';

describe('EmbeddingClient', () => {
    it('fetches embeddings', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
        });

        const client = new EmbeddingClient('fake-token');
        const vector = await client.getEmbedding('test text');
        
        expect(vector).toEqual([0.1, 0.2, 0.3]);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.openai.com/v1/embeddings',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('text-embedding-3-small')
            })
        );
    });

    it('computes cosine similarity correctly', () => {
        const v1 = [1, 0, 0];
        const v2 = [0, 1, 0];
        const v3 = [1, 1, 0];
        
        expect(cosineSimilarity(v1, v2)).toBe(0);
        expect(cosineSimilarity(v1, v1)).toBe(1);
        expect(cosineSimilarity(v1, v3)).toBeCloseTo(0.707);
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/embedding-client.test.ts`

**Step 3: Write minimal implementation**
```typescript
export class EmbeddingClient {
    constructor(private apiKey: string) {}

    async getEmbedding(text: string): Promise<number[]> {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                input: text,
                model: 'text-embedding-3-small'
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.data[0].embedding;
    }
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/embedding-client.test.ts`

**Step 5: Commit**
```bash
git add src/llm/embedding-client.ts tests/llm/embedding-client.test.ts
git commit -m "feat: add EmbeddingClient and cosine similarity #gemini"
```

---

### Task 2: Create Episodic Memory Store (Graph RAG Base)

**Files:**
- Create: `src/memory/episodic-store.ts`
- Create: `tests/memory/episodic-store.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EpisodicStore, type Episode } from '../../src/memory/episodic-store.js';
import * as fs from 'fs';
import * as path from 'path';

describe('EpisodicStore', () => {
    const testDir = path.join(process.cwd(), 'tmp_test_memory');
    const dbPath = path.join(testDir, 'memory-graph.json');

    beforeEach(() => {
        if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);
    });

    afterEach(() => {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    });

    it('saves and loads episodes', () => {
        const store = new EpisodicStore(dbPath);
        const episode: Episode = {
            id: '1',
            timestamp: Date.now(),
            textSummary: 'Market chopped. Longed.',
            embedding: [0.1, 0.5],
            resultPnl: -2
        };

        store.addEpisode(episode);
        
        const store2 = new EpisodicStore(dbPath);
        expect(store2.getAll()).toHaveLength(1);
        expect(store2.getAll()[0].id).toBe('1');
    });

    it('retrieves top K similar episodes', () => {
        const store = new EpisodicStore(dbPath);
        store.addEpisode({ id: '1', timestamp: 1, textSummary: 'A', embedding: [1, 0], resultPnl: 0 }); // Sim: 1.0 (exact match)
        store.addEpisode({ id: '2', timestamp: 2, textSummary: 'B', embedding: [0, 1], resultPnl: 0 }); // Sim: 0.0 (orthogonal)
        store.addEpisode({ id: '3', timestamp: 3, textSummary: 'C', embedding: [0.707, 0.707], resultPnl: 0 }); // Sim: ~0.707

        const results = store.search([1, 0], 2);
        expect(results).toHaveLength(2);
        expect(results[0].episode.id).toBe('1');
        expect(results[1].episode.id).toBe('3');
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/memory/episodic-store.test.ts`

**Step 3: Write minimal implementation**
```typescript
import * as fs from 'fs';
import { cosineSimilarity } from '../llm/embedding-client.js';

export interface Episode {
    id: string;
    timestamp: number;
    textSummary: string; // The text that was embedded
    embedding: number[];
    resultPnl: number;
    // We can add raw state snapshots here later if needed
}

export class EpisodicStore {
    private episodes: Episode[] = [];

    constructor(private filePath: string) {
        this.load();
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                this.episodes = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            } catch (e) {
                console.error('Failed to load episodic graph', e);
                this.episodes = [];
            }
        }
    }

    private save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.episodes, null, 2));
    }

    addEpisode(episode: Episode) {
        this.episodes.push(episode);
        this.save();
    }

    getAll(): Episode[] {
        return this.episodes;
    }

    search(queryEmbedding: number[], topK: number = 3): { episode: Episode; score: number }[] {
        const scored = this.episodes.map(ep => ({
            episode: ep,
            score: cosineSimilarity(queryEmbedding, ep.embedding)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, Math.min(topK, scored.length));
    }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/memory/episodic-store.test.ts`

**Step 5: Commit**
```bash
git add src/memory/episodic-store.ts tests/memory/episodic-store.test.ts
git commit -m "feat: add local JSON EpisodicStore for Graph RAG #gemini"
```

---

### Task 3: Create Episodic Agent (Extraction & Retrieval)

**Files:**
- Create: `src/llm/episodic-agent.ts`
- Create: `tests/llm/episodic-agent.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, it, expect, vi } from 'vitest';
import { EpisodicAgent } from '../../src/llm/episodic-agent.js';
import type { EmbeddingClient } from '../../src/llm/embedding-client.js';
import type { EpisodicStore, Episode } from '../../src/memory/episodic-store.js';

describe('EpisodicAgent', () => {
    it('retrieves and formats similar experiences', async () => {
        const mockEmbedding = {
            getEmbedding: vi.fn().mockResolvedValue([0.5, 0.5])
        } as unknown as EmbeddingClient;

        const mockStore = {
            search: vi.fn().mockReturnValue([
                { score: 0.95, episode: { textSummary: 'Market chopped. Long failed.', resultPnl: -2 } },
                { score: 0.85, episode: { textSummary: 'High volume breakout.', resultPnl: 5 } }
            ])
        } as unknown as EpisodicStore;

        const agent = new EpisodicAgent(mockEmbedding, mockStore);
        const context = await agent.getRelevantContext('Current market is sideways.');

        expect(mockEmbedding.getEmbedding).toHaveBeenCalledWith('Current market is sideways.');
        expect(context).toContain('Market chopped. Long failed.');
        expect(context).toContain('High volume breakout.');
        expect(context).toContain('-2');
        expect(context).toContain('+5'); // Sign formatted
    });

    it('returns empty string if nothing relevant', async () => {
        const mockEmbedding = { getEmbedding: vi.fn().mockResolvedValue([0.5, 0.5]) } as any;
        const mockStore = { search: vi.fn().mockReturnValue([]) } as any;

        const agent = new EpisodicAgent(mockEmbedding, mockStore);
        const context = await agent.getRelevantContext('Current market is sideways.');

        expect(context).toBe('');
    });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/episodic-agent.test.ts`

**Step 3: Write minimal implementation**
```typescript
import type { EmbeddingClient } from './embedding-client.js';
import type { EpisodicStore } from '../memory/episodic-store.js';

export class EpisodicAgent {
    constructor(
        private embeddingClient: EmbeddingClient,
        private store: EpisodicStore
    ) {}

    async getRelevantContext(currentStateDescription: string, topK: number = 3): Promise<string> {
        let embedding: number[];
        try {
            embedding = await this.embeddingClient.getEmbedding(currentStateDescription);
        } catch (e) {
            console.error('[EpisodicAgent] Failed to get embedding for query:', e);
            return '';
        }

        const matches = this.store.search(embedding, topK);
        // We only want highly relevant matches (e.g. cosine similarity > 0.7)
        const strongMatches = matches.filter(m => m.score > 0.7);

        if (strongMatches.length === 0) return '';

        let promptAddition = '### SIMILAR PAST EPISODES (Graph RAG)\n\nI have retrieved the most similar historical scenarios from your episodic memory. Use these outcomes to inform your current decision:\n\n';
        
        strongMatches.forEach((m, idx) => {
            const sign = m.episode.resultPnl >= 0 ? '+' : '';
            promptAddition += `**Episode ${idx+1} (Relevance: ${(m.score*100).toFixed(0)}%)**\n`;
            promptAddition += `- Scenario: ${m.episode.textSummary}\n`;
            promptAddition += `- Outcome: ${sign}${m.episode.resultPnl}%\n\n`;
        });

        return promptAddition;
    }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/episodic-agent.test.ts`

**Step 5: Commit**
```bash
git add src/llm/episodic-agent.ts tests/llm/episodic-agent.test.ts
git commit -m "feat: add EpisodicAgent for RAG retrieval #gemini"
```

---

### Task 4: Integrate Episodic RAG into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/index.ts`
- Modify: `src/llm/prompts.ts`
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**
Modify `tests/trading-loop.test.ts` to mock the Episodic Agent and verify it is called and the prompt data includes knowledge.

```typescript
// Inside tests/trading-loop.test.ts, add a new test block:
  it('calls EpisodicAgent to fetch RAG context', async () => {
    const mockEpisodicAgent = {
      getRelevantContext: vi.fn().mockResolvedValue('Past Episode: Chop. PNL -2%')
    };
    
    const loopRAG = new TradingLoop({
      // include all required deps ...
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      episodicAgent: mockEpisodicAgent as any,
    });

    await loopRAG.runOnce();

    expect(mockEpisodicAgent.getRelevantContext).toHaveBeenCalled();
    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.ragContext).toBe('Past Episode: Chop. PNL -2%');
  });
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/trading-loop.test.ts -t "EpisodicAgent"`

**Step 3: Write minimal implementation**

Modify `src/llm/prompts.ts`:
1. Add `ragContext?: string;` to `EnrichedPromptData`
2. Update `buildUserPrompt` to append `data.ragContext` if it exists.

Modify `src/trading-loop.ts`:
1. Add `episodicAgent?: import('./llm/episodic-agent.js').EpisodicAgent;` to `TradingLoopDeps`
2. In `runOnce`, before `const promptData = { ... }`, construct a string summary of the current state (`currentStateStr`).
3. Call `const ragContext = await this.deps.episodicAgent?.getRelevantContext(currentStateStr);`
4. Inject `ragContext` into `promptData`.

Modify `src/index.ts`:
1. Instantiate `EmbeddingClient`. (Provide API key from `process.env.OPENAI_API_KEY`).
2. Instantiate `EpisodicStore('data/memory-graph.json')`.
3. Instantiate `EpisodicAgent(embeddingClient, episodicStore)`.
4. Pass `episodicAgent` into `TradingLoop` deps.

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/trading-loop.test.ts`

**Step 5: Commit**
```bash
git add src/trading-loop.ts src/index.ts src/llm/prompts.ts tests/trading-loop.test.ts
git commit -m "feat: integrate EpisodicAgent Graph RAG into TradingLoop #gemini"
```
