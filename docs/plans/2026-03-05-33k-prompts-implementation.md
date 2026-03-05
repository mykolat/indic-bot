# Implementation Plan: Layer 1 Prompts & Chief Architect CoT

## Goal Description
The core structural components of the 33k Multi-Agent "Sandwich" architecture (SoulKeeper, Mandatory CoT Checklist, Layer 1 Agent interfaces, and Trading Loop integration) have been implemented. This plan dictates the next phase: implementing the actual LLM prompts for the three Layer 1 Agents (News, Macro, Soul) and completely overhauling the Chief Architect (Layer 2) prompt to consume these reports and strictly output the `MandatoryCoTChecklist`.

## Proposed Changes

---

### Layer 1 Agent Prompts
Define the system prompts for the distillation agents.

#### [MODIFY] `src/llm/agents.ts`
Implement robust system prompts for the three parallel Layer 1 calls:
- **NewsExpert:** Extract only actionable catalysts, sentiment shifts, and high-impact news from the raw `newsData`. Format as a concise JSON report.
- **MacroExpert:** Analyze the `macroData` (Fear & Greed, BTC Dominance, funding rates) to determine the overall market risk appetite. Format as a concise JSON report.
- **SoulExpert:** Review the `soulData` (past failures, invisible exits, rejected trades) and extract specific warnings or patterns relevant to the current market state. Format as a concise JSON report.

---

### Chief Architect Prompt Overhaul
Refactor the main trading prompt to ingest the Layer 1 reports and output the strictly typed CoT checklist alongside the trade decisions.

#### [MODIFY] `src/llm/prompts.ts`
- **`buildEnrichedPrompt`:** Update to accept and format the `layer1Reports` (News, Macro, Soul).
- **`buildSystemPrompt`:** 
  - Remove all old raw data parsing instructions.
  - Instruct the LLM that it is the "Chief Architect" receiving distilled intelligence.
  - **CRITICAL:** Mandate that the response MUST include a `cot_checklist` object matching the `MandatoryCoTChecklist` schema *before* returning any `TradeDecision` array.
  - Update the expected JSON schema in the prompt instructions to include the CoT payload.

---

### LLM Client Parser Update
Ensure the LLM client handles the new combined JSON output (Checklist + Decisions).

#### [MODIFY] `src/llm/client.ts`
- Update the `analyze` return signature to optionally return the `cot_checklist` or handle it internally.
- *Alternatively*, keep the client returning `TradeDecision[]` but modify the internal parser to expect the checklist, run it through `validateCoTChecklist`, and then extract the `decisions` array. We will go with the latter for simplicity in the trading loop.
- Implement robust JSON parsing that can extract both the CoT and the trade decisions from the LLM's raw string response.

## Verification Plan

### Automated Tests
- Run `npx vitest run tests/llm/prompts.test.ts` to verify the new prompt structure generates correctly with Layer 1 inputs.
- Run `npx vitest run tests/llm/client.test.ts` (or equivalent parsing tests) to ensure the parser correctly extracts decisions even when prefixed with the CoT checklist.
- Run the full suite (`npx vitest run`) to ensure no regressions.

### Manual Verification
- Run a dry-run iteration (`npm run dev`) or test script to verify the specific LLM API calls and parse handling of the new complex JSON structure.
