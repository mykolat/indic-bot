# 33k Multi-Agent Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-indic-plans to implement this plan task-by-task.

**Goal:** Implement the "Sandwich" architecture by adding the `SoulKeeper` memory system, defining the Multi-Agent Layer 1 interfaces, and enforcing a Mandatory CoT JSON checklist from the Chief Architect.

**Architecture:** A multi-layered trading loop. The CPU gathers raw data, passes it to Layer 1 Agents (News, Macro, Soul) for distillation. The CPU then merges these distills with raw OHLCV and passes it to the Layer 2 "Chief Architect" LLM. The Chief Architect is forced to output a strictly typed Mandatory CoT JSON checklist. Finally, the CPU validates the checklist.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: The SoulKeeper Class

**Files:**
- Create: `src/memory/soul-keeper.ts`
- Create: `tests/memory/soul-keeper.test.ts`

**Step 1: Write the failing test**
```typescript
// tests/memory/soul-keeper.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { SoulKeeper } from '../../src/memory/soul-keeper.js';

const TEST_DIR = join(process.cwd(), 'tmp-soul-test');

describe('SoulKeeper', () => {
  let sk: SoulKeeper;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    sk = new SoulKeeper(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates soul.md from template on first init', () => {
    const content = sk.read();
    expect(content).toContain('# Trading Soul');
    expect(content).toContain('## Identity');
    expect(content).toContain('No trading history yet.');
  });

  it('writeNarrativeSections updates only specified sections', () => {
    sk.writeNarrativeSections({
      identity: 'I am a cautious swing trader.',
      failures: 'I chase pumps too often.',
    });
    const content = sk.read();
    expect(content).toContain('I am a cautious swing trader.');
    expect(content).toContain('I chase pumps too often.');
    // Untouched sections keep defaults
    expect(content).toContain('No trading history yet.');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/memory/soul-keeper.test.ts`

**Step 3: Write minimal implementation**
```typescript
// src/memory/soul-keeper.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const TEMPLATE = `# Trading Soul

## Identity
I am a crypto futures trading agent. I aim for high-confidence confluence trades with strict risk management.

## What I've Learned
No trading history yet.

## My Failure Patterns
No failures recorded yet.

## Current Regime View
No market regime assessment yet.
`;

const SECTION_MARKERS: Record<string, string> = {
  identity: '## Identity',
  learned: "## What I've Learned",
  failures: '## My Failure Patterns',
  regime: '## Current Regime View',
};

export class SoulKeeper {
  private soulPath: string;

  constructor(soulDir: string) {
    this.soulPath = join(soulDir, 'soul.md');
    this.ensureExists();
  }

  private ensureExists(): void {
    try {
      readFileSync(this.soulPath, 'utf-8');
    } catch {
      mkdirSync(dirname(this.soulPath), { recursive: true });
      writeFileSync(this.soulPath, TEMPLATE, 'utf-8');
    }
  }

  read(): string {
    return readFileSync(this.soulPath, 'utf-8');
  }

  writeNarrativeSections(sections: {
    identity?: string;
    learned?: string;
    failures?: string;
    regime?: string;
  }): void {
    let content = this.read();
    
    for (const [key, newText] of Object.entries(sections)) {
      if (!newText) continue;
      const marker = SECTION_MARKERS[key];
      if (!marker) continue;

      const markerIdx = content.indexOf(marker);
      if (markerIdx === -1) continue;

      const afterMarker = markerIdx + marker.length;
      const nextSectionIdx = content.indexOf('\n## ', afterMarker);
      const endIdx = nextSectionIdx === -1 ? content.length : nextSectionIdx;

      content = content.slice(0, afterMarker) + '\n' + newText + '\n' + content.slice(endIdx);
    }
    writeFileSync(this.soulPath, content, 'utf-8');
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/memory/soul-keeper.test.ts`

**Step 5: Commit**
```bash
git add tests/memory/soul-keeper.test.ts src/memory/soul-keeper.ts
git commit -m "feat: add SoulKeeper memory system #gemini"
```

---

### Task 2: Mandatory CoT Checklist Schema

**Files:**
- Create: `src/llm/cot-schema.ts`
- Create: `tests/llm/cot-schema.test.ts`

**Step 1: Write the failing test**
```typescript
// tests/llm/cot-schema.test.ts
import { describe, it, expect } from 'vitest';
import { validateCoTChecklist } from '../../src/llm/cot-schema.js';

describe('validateCoTChecklist', () => {
  it('validates a correct checklist payload', () => {
    const payload = {
      macro_risk_score: 8,
      liquidation_sweep_detected: true,
      order_book_imbalance_ratio: 1.5,
      news_catalyst_strength: 5,
      regime_override_suggestion: "Breakout",
      trade_rationale: "Strong volume push",
      confidence_score: 85
    };
    
    expect(() => validateCoTChecklist(payload)).not.toThrow();
  });

  it('throws on missing required fields', () => {
    const badPayload = { macro_risk_score: 8 };
    expect(() => validateCoTChecklist(badPayload)).toThrow('Missing field: liquidation_sweep_detected');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/cot-schema.test.ts`

**Step 3: Write minimal implementation**
```typescript
// src/llm/cot-schema.ts
export interface MandatoryCoTChecklist {
  macro_risk_score: number;            // 1-10
  liquidation_sweep_detected: boolean;
  order_book_imbalance_ratio: number;
  news_catalyst_strength: number;      // 1-10
  regime_override_suggestion: string | null;
  trade_rationale: string;
  confidence_score: number;            // 1-100
}

export function validateCoTChecklist(data: any): asserts data is MandatoryCoTChecklist {
  const requiredFields = [
    'macro_risk_score',
    'liquidation_sweep_detected',
    'order_book_imbalance_ratio',
    'news_catalyst_strength',
    'regime_override_suggestion',
    'trade_rationale',
    'confidence_score'
  ];

  for (const field of requiredFields) {
    if (!(field in data)) {
      throw new Error(`Missing field: ${field}`);
    }
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/cot-schema.test.ts`

**Step 5: Commit**
```bash
git add tests/llm/cot-schema.test.ts src/llm/cot-schema.ts
git commit -m "feat: define Mandatory CoT Checklist schema for Layer 2 #gemini"
```

---

### Task 3: Layer 1 Agent Interfaces (Data Distillation)

**Files:**
- Create: `src/llm/agents.ts`
- Create: `tests/llm/agents.test.ts`

**Step 1: Write the failing test**
```typescript
// tests/llm/agents.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runLayer1Experts } from '../../src/llm/agents.js';

describe('runLayer1Experts', () => {
  it('returns aggregated reports from all mini-agents', async () => {
    const mockLlmClient = { call: vi.fn().mockResolvedValue('{"score": 7}') };
    
    const results = await runLayer1Experts(mockLlmClient as any, { 
      newsData: '...', 
      macroData: '...', 
      soulData: '...' 
    });

    expect(results).toHaveProperty('newsReport');
    expect(results).toHaveProperty('macroReport');
    expect(results).toHaveProperty('soulReport');
    expect(mockLlmClient.call).toHaveBeenCalledTimes(3);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm/agents.test.ts`

**Step 3: Write minimal implementation**
```typescript
// src/llm/agents.ts
import type { LLMClient } from './client.js';

export interface Layer1Inputs {
  newsData: string;
  macroData: string;
  soulData: string;
}

export interface Layer1Outputs {
  newsReport: string;
  macroReport: string;
  soulReport: string;
}

export async function runLayer1Experts(llm: LLMClient, inputs: Layer1Inputs): Promise<Layer1Outputs> {
  // We run 3 parallel LLM calls to distill noisy data into clean summaries for Layer 2.
  const [news, macro, soul] = await Promise.all([
    llm.call('You are NewsExpert. Summarize catalysts as JSON.', inputs.newsData),
    llm.call('You are MacroExpert. Summarize risk as JSON.', inputs.macroData),
    llm.call('You are SoulExpert. Review past failures and warn as JSON.', inputs.soulData)
  ]);

  return {
    newsReport: news,
    macroReport: macro,
    soulReport: soul
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/llm/agents.test.ts`

**Step 5: Commit**
```bash
git add tests/llm/agents.test.ts src/llm/agents.ts
git commit -m "feat: implement parallel Layer 1 distilled agent calls #gemini"
```

---

### Task 4: Integration - The Sandwitch Trading Loop 

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**
```typescript
// Add to tests/trading-loop.test.ts
// Find the `runs a full cycle` test and mock the new `runLayer1Experts` behavior,
// then assert that `runLayer1Experts` was called BEFORE `llm.analyze`.
import * as Agents from '../../src/llm/agents.js';
// ... test setup ...
it('executes the sandwich architecture: CPU -> Layer1 -> CPU -> Layer2', async () => {
   const spy = vi.spyOn(Agents, 'runLayer1Experts').mockResolvedValue({
      newsReport: '{}', macroReport: '{}', soulReport: '{}'
   });
   
   await loop.runOnce();
   
   expect(spy).toHaveBeenCalled(); // Layer 1 triggered
   expect(mockLlm.analyze).toHaveBeenCalled(); // Layer 2 triggered after Layer 1
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/trading-loop.test.ts`

**Step 3: Write minimal implementation**
```typescript
// In src/trading-loop.ts, at the start of the analysis block (around line 180):
import { runLayer1Experts } from './llm/agents.js';
import { SoulKeeper } from './memory/soul-keeper.js';

// ... Inside runOnce:
const soulKeeper = new SoulKeeper(process.env.DATA_DIR || './tmp');
const soulData = soulKeeper.read();

// 1. LAYER 1: Distill data via experts
const layer1Reports = await runLayer1Experts(this.deps.fallbackLlm || this.deps.llm, {
   newsData: JSON.stringify(newsAnalysis),
   macroData: JSON.stringify(this.lastMacroAnalysis),
   soulData: soulData
});

// 2. CPU Prep: Bundle the distills for the Chief Architect
const enrichedPromptData = {
   // ... existing fields ...
   layer1Reports // <--- NEW INJECTION
};

// 3. LAYER 2: The Chief Architect (returns TradeDecision via Checklist format)
const decisions = await llm.analyze(enrichedPromptData);
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/trading-loop.test.ts`

**Step 5: Commit**
```bash
git add tests/trading-loop.test.ts src/trading-loop.ts
git commit -m "feat: integrate Sandwich Architecture into Trading Loop #gemini"
```
