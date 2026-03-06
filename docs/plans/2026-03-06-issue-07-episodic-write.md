# Issue #7: Episodic Memory (Graph RAG) never written in production

## Problem

`EpisodicStore.addEpisode()` exists (line 44 of `src/memory/episodic-store.ts`) but is **never called** anywhere in production code. The only caller is the unit test (`tests/memory/episodic-store.test.ts`).

As a result, `EpisodicAgent.getRelevantContext()` always searches an empty store, meaning the Graph RAG feature — which embeds the current market state and retrieves similar past episodes — returns empty context every cycle. The entire RAG pipeline (embedding → search → prompt injection) is wired but starved of data.

## Root Cause

In `src/trading-loop.ts`, after a CLOSE executes (line 862), the loop logs the trade to `SessionMemory`, `TradeStoryLogger`, and DB (`insertTradeClose`), but never creates an `Episode` from the closed trade and calls `episodicStore.addEpisode()`.

The `EpisodicStore` instance is created inside `src/index.ts` (line 206) and passed into `EpisodicAgent`, but the store reference itself is never exposed to `TradingLoop` — only the `EpisodicAgent` is injected as a dep.

## Solution

1. Expose `EpisodicStore` as a separate dep on `TradingLoop` (alongside `episodicAgent`).
2. After every CLOSE (both LLM-driven and auto-exit), build a text summary of the trade context and call `addEpisode()` via the embedding client.
3. The episode text should include: pair, direction, regime, key indicators, reasoning, PnL — so future similarity searches can find analogous situations.

## Files to Modify

| File | Change |
|------|--------|
| `src/trading-loop.ts` | Add `episodicStore` + `embeddingClient` deps; call `addEpisode()` after CLOSE |
| `src/index.ts` | Pass `episodicStore` and `embeddingClient` to `TradingLoop` |
| `tests/memory/episodic-store.test.ts` | Add integration test for episode creation from trade data |
| `tests/trading-loop.test.ts` | Add test verifying `addEpisode()` is called after CLOSE |

## Implementation Steps (TDD)

### Step 1: Write failing test — EpisodicStore gets called after CLOSE

Add a test in `tests/trading-loop.test.ts` that verifies `addEpisode` is called when a CLOSE decision executes successfully.

```typescript
// tests/trading-loop.test.ts — add after existing tests

it('calls episodicStore.addEpisode after successful CLOSE', async () => {
  const mockEpisodicStore = {
    addEpisode: vi.fn(),
  };
  const mockEmbeddingClient = {
    getEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  };

  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 100,
    availableUsd: 80,
    positions: [
      { pair: 'BTCUSDT', sizeUsd: 200, leverage: 10, side: 'LONG', entryPrice: 50000, unrealizedPnlPct: 5.0, heldHours: 2 },
    ],
    sessionPnl: 5,
    drawdownPct: 0,
  });

  mockLlm.analyze.mockResolvedValue([
    { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'take profit', confidence: 80 },
  ]);

  const closeLoop = new TradingLoop({
    pairs: ['BTCUSDT'],
    marketData: mockMarketData,
    llm: mockLlm,
    orders: mockOrders,
    riskManager: mockRisk,
    signalBuffer: mockSignalBuffer,
    logger: mockLogger,
    memory: mockSessionMemory,
    newsCache: { shouldRefresh: vi.fn().mockReturnValue(false), getAnalysis: vi.fn().mockReturnValue(null), load: vi.fn().mockReturnValue(null), save: vi.fn(), appendHistory: vi.fn(), getRecentItems: vi.fn().mockReturnValue([]), dbCount: vi.fn().mockReturnValue(0) } as any,
    newsAnalyst: { analyze: vi.fn().mockResolvedValue({ market_summary: 'test', top_signals: [], overall_sentiment: 'neutral', macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' }, risk_events: [] }) } as any,
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    churnCooldownMs: 900000,
    tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    memoryKeeper: mockMemoryKeeper,
    episodicStore: mockEpisodicStore as any,
    embeddingClient: mockEmbeddingClient as any,
  });

  await closeLoop.runOnce();

  expect(mockEmbeddingClient.getEmbedding).toHaveBeenCalledTimes(1);
  expect(mockEpisodicStore.addEpisode).toHaveBeenCalledTimes(1);

  const episode = mockEpisodicStore.addEpisode.mock.calls[0][0];
  expect(episode.textSummary).toContain('BTCUSDT');
  expect(episode.textSummary).toContain('LONG');
  expect(episode.resultPnl).toBe(5.0);
  expect(episode.embedding).toEqual([0.1, 0.2, 0.3]);
});
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — fails because `episodicStore` and `embeddingClient` are not recognized deps and `addEpisode` is never called.

### Step 2: Add deps to TradingLoopDeps interface

In `src/trading-loop.ts`, add the new optional deps to the `TradingLoopDeps` interface (around line 71):

```typescript
// src/trading-loop.ts — TradingLoopDeps interface (after line 81)
  episodicStore?: import('../memory/episodic-store.js').EpisodicStore;
  embeddingClient?: import('../llm/embedding-client.js').EmbeddingClient;
```

Note: `episodicAgent` (line 71) already exists. The new deps are separate because we need the raw store for writes and the embedding client for generating embeddings, while `episodicAgent` is the read-side wrapper.

### Step 3: Implement addEpisode call after CLOSE

In `src/trading-loop.ts`, after the successful CLOSE block (after `tradeStoryLogger` call, around line 904), add the episodic memory write:

```typescript
// src/trading-loop.ts — inside the `if (result.success)` block after CLOSE (after line 904)

// Write episodic memory for Graph RAG
if (this.deps.episodicStore && this.deps.embeddingClient) {
  const ind = indicators.get(decision.pair);
  const episodeSummary = [
    `Pair: ${decision.pair}. Direction: ${pos.side}.`,
    `Regime: ${marketRegime}.`,
    `RSI: ${ind?.rsi?.toFixed(0) ?? '?'}. Volume: ${ind?.volumeRatio?.toFixed(1) ?? '?'}x.`,
    `ADX: ${ind?.adx?.toFixed(0) ?? '?'}. Trend: ${ind?.trend ?? 'unknown'}.`,
    `Held: ${pos.heldHours.toFixed(1)}h. PnL: ${pos.unrealizedPnlPct >= 0 ? '+' : ''}${pos.unrealizedPnlPct.toFixed(1)}%.`,
    `Reasoning: ${decision.reasoning}`,
  ].join(' ');

  this.deps.embeddingClient.getEmbedding(episodeSummary)
    .then(embedding => {
      this.deps.episodicStore!.addEpisode({
        id: `${decision.pair}-${Date.now()}`,
        timestamp: Date.now(),
        textSummary: episodeSummary,
        embedding,
        resultPnl: pos.unrealizedPnlPct,
      });
      console.log(`[EpisodicRAG] Saved episode for ${decision.pair} CLOSE (PnL: ${pos.unrealizedPnlPct.toFixed(1)}%)`);
    })
    .catch(err => {
      console.error('[EpisodicRAG] Failed to save episode:', err.message);
    });
}
```

### Step 4: Also write episodes for auto-exits

In `src/trading-loop.ts`, in the auto-exit loop (around line 217–244), add the same pattern after the auto-exit CLOSE succeeds. Extract a helper method to avoid duplication:

```typescript
// src/trading-loop.ts — new private method on TradingLoop class

private saveEpisode(
  pair: string,
  side: string,
  regime: string,
  indicators: Map<string, import('./indicators/technical.js').Indicators>,
  heldHours: number,
  pnlPct: number,
  reasoning: string,
): void {
  if (!this.deps.episodicStore || !this.deps.embeddingClient) return;

  const ind = indicators.get(pair);
  const summary = [
    `Pair: ${pair}. Direction: ${side}.`,
    `Regime: ${regime}.`,
    `RSI: ${ind?.rsi?.toFixed(0) ?? '?'}. Volume: ${ind?.volumeRatio?.toFixed(1) ?? '?'}x.`,
    `ADX: ${ind?.adx?.toFixed(0) ?? '?'}. Trend: ${ind?.trend ?? 'unknown'}.`,
    `Held: ${heldHours.toFixed(1)}h. PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%.`,
    `Reasoning: ${reasoning}`,
  ].join(' ');

  this.deps.embeddingClient.getEmbedding(summary)
    .then(embedding => {
      this.deps.episodicStore!.addEpisode({
        id: `${pair}-${Date.now()}`,
        timestamp: Date.now(),
        textSummary: summary,
        embedding,
        resultPnl: pnlPct,
      });
      console.log(`[EpisodicRAG] Saved episode for ${pair} (PnL: ${pnlPct.toFixed(1)}%)`);
    })
    .catch(err => console.error('[EpisodicRAG] Failed to save episode:', err.message));
}
```

Then call `this.saveEpisode(...)` from both the CLOSE block and the auto-exit block.

### Step 5: Wire in src/index.ts

In `src/index.ts` (around line 206), the `episodicStore` is already created but only passed to `EpisodicAgent`. Pass it (and `embeddingClient`) directly to `TradingLoop`:

```typescript
// src/index.ts — where TradingLoop deps are assembled (around line 214)
    episodicAgent,
    episodicStore,                    // NEW — for writing episodes on CLOSE
    embeddingClient: embeddingClient, // NEW — for generating embeddings
```

The `embeddingClient` variable already exists at line 205. The `episodicStore` variable already exists at line 206. Just need to add them to the deps object passed to `new TradingLoop({...})`.

### Step 6: Write failing test — embedding failure is graceful

```typescript
// tests/trading-loop.test.ts — add test

it('handles embedding failure gracefully when saving episode', async () => {
  const mockEpisodicStore = { addEpisode: vi.fn() };
  const mockEmbeddingClient = {
    getEmbedding: vi.fn().mockRejectedValue(new Error('API timeout')),
  };

  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 100, availableUsd: 80,
    positions: [
      { pair: 'BTCUSDT', sizeUsd: 200, leverage: 10, side: 'LONG', entryPrice: 50000, unrealizedPnlPct: 5.0, heldHours: 2 },
    ],
    sessionPnl: 5, drawdownPct: 0,
  });
  mockLlm.analyze.mockResolvedValue([
    { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'tp hit', confidence: 80 },
  ]);

  const closeLoop = new TradingLoop({
    pairs: ['BTCUSDT'],
    marketData: mockMarketData, llm: mockLlm, orders: mockOrders,
    riskManager: mockRisk, signalBuffer: mockSignalBuffer, logger: mockLogger,
    memory: mockSessionMemory,
    newsCache: { shouldRefresh: vi.fn().mockReturnValue(false), load: vi.fn().mockReturnValue(null), save: vi.fn(), appendHistory: vi.fn(), getRecentItems: vi.fn().mockReturnValue([]), dbCount: vi.fn().mockReturnValue(0) } as any,
    newsAnalyst: { analyze: vi.fn().mockResolvedValue({ market_summary: '', top_signals: [], overall_sentiment: 'neutral', macro_signals: { fed_stance: 'neutral', risk_appetite: 'moderate', dominance_trend: 'stable' }, risk_events: [] }) } as any,
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    churnCooldownMs: 900000,
    tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    memoryKeeper: mockMemoryKeeper,
    episodicStore: mockEpisodicStore as any,
    embeddingClient: mockEmbeddingClient as any,
  });

  // Should not throw despite embedding failure
  await expect(closeLoop.runOnce()).resolves.not.toThrow();
  expect(mockEpisodicStore.addEpisode).not.toHaveBeenCalled();
});
```

**Verify:** `npx vitest run tests/trading-loop.test.ts` — passes (the `.catch()` in saveEpisode prevents crashes).

### Step 7: Write unit test — episode summary contains correct fields

```typescript
// tests/memory/episodic-store.test.ts — add test

it('episode textSummary contains trade context fields', () => {
  const store = new EpisodicStore(dbPath);
  const episode: Episode = {
    id: 'BTCUSDT-1709740800000',
    timestamp: 1709740800000,
    textSummary: 'Pair: BTCUSDT. Direction: LONG. Regime: BullTrend. RSI: 65. Volume: 1.3x. ADX: 30. Trend: bullish. Held: 4.2h. PnL: +3.5%. Reasoning: Trend continuation after pullback.',
    embedding: [0.1, 0.2, 0.3],
    resultPnl: 3.5,
  };

  store.addEpisode(episode);
  const all = store.getAll();
  expect(all).toHaveLength(1);
  expect(all[0].textSummary).toContain('BTCUSDT');
  expect(all[0].textSummary).toContain('BullTrend');
  expect(all[0].textSummary).toContain('LONG');
  expect(all[0].resultPnl).toBe(3.5);
});
```

**Verify:** `npx vitest run tests/memory/episodic-store.test.ts` — passes (this validates the data shape).

### Step 8: Run full test suite and commit

```bash
npx vitest run tests/trading-loop.test.ts tests/memory/episodic-store.test.ts
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts tests/memory/episodic-store.test.ts
git commit -m "feat(issue-7): write episodic memory on CLOSE for Graph RAG"
```

## Verification

After deployment, check that episodes are being written:

1. **Local file:** `cat ~/.indic-bot/memory-graph.json | jq '. | length'` should grow after CLOSEs.
2. **DB:** `SELECT count(*) FROM episodic_memories;` should increment.
3. **Logs:** Look for `[EpisodicRAG] Saved episode for ...` messages in pm2 logs.
4. **RAG context:** After a few episodes exist, the `### SIMILAR PAST EPISODES` section should appear in LLM prompts when market conditions resemble past trades.
