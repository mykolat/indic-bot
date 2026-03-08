import { describe, it, expect, vi } from 'vitest';
import { NewsEnricher } from '../../src/news/news-enricher.js';
import type { NewsEvent } from '../../src/news/types.js';

const makeEvent = (title: string, url = 'https://example.com/1'): NewsEvent => ({
  title, date: '', url, source: 'CoinDesk', sourceType: 'newsroom',
  coins: [], sentiment: 0, tickers: [], topics: [], priority: 0,
});

describe('NewsEnricher', () => {
  it('enriches events with tickers, topics, priority from LLM', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify([
        { tickers: ['ETH'], topics: ['ETF'], priority: 0.9 },
        { tickers: ['BTC'], topics: ['Regulation'], priority: 0.7 },
      ])),
    };
    const enricher = new NewsEnricher(mockLlm as any);
    const events = [makeEvent('SEC delays ETH ETF'), makeEvent('BTC regulations coming', 'https://example.com/2')];

    const result = await enricher.enrich(events);

    expect(result[0].tickers).toEqual(['ETH']);
    expect(result[0].topics).toEqual(['ETF']);
    expect(result[0].priority).toBe(0.9);
    expect(result[1].tickers).toEqual(['BTC']);
    expect(mockLlm.call).toHaveBeenCalledOnce();
  });

  it('returns original events if LLM fails', async () => {
    const mockLlm = { call: vi.fn().mockRejectedValue(new Error('timeout')) };
    const enricher = new NewsEnricher(mockLlm as any);
    const events = [makeEvent('Some news')];

    const result = await enricher.enrich(events);
    expect(result).toHaveLength(1);
    expect(result[0].tickers).toEqual([]);
    expect(result[0].priority).toBe(0);
  });

  it('returns original events if LLM returns invalid JSON', async () => {
    const mockLlm = { call: vi.fn().mockResolvedValue('not json at all') };
    const enricher = new NewsEnricher(mockLlm as any);
    const events = [makeEvent('Some news')];

    const result = await enricher.enrich(events);
    expect(result[0].tickers).toEqual([]);
  });

  it('handles empty input', async () => {
    const mockLlm = { call: vi.fn() };
    const enricher = new NewsEnricher(mockLlm as any);
    const result = await enricher.enrich([]);
    expect(result).toEqual([]);
    expect(mockLlm.call).not.toHaveBeenCalled();
  });

  it('caps batch at 50 events for LLM call', async () => {
    const events = Array.from({ length: 80 }, (_, i) => makeEvent(`News ${i}`, `https://x.com/${i}`));
    const mockLlm = {
      call: vi.fn().mockResolvedValue(JSON.stringify(
        Array.from({ length: 50 }, () => ({ tickers: [], topics: [], priority: 0 }))
      )),
    };
    const enricher = new NewsEnricher(mockLlm as any);
    const result = await enricher.enrich(events);
    expect(result).toHaveLength(80); // all returned, 50 enriched + 30 passthrough
    expect(mockLlm.call).toHaveBeenCalledOnce();
  });
});
