import { describe, it, expect } from 'vitest';
import { buildNewsMarketFusion, formatFusionBlock } from '../../src/news/news-market-fusion.js';
import type { NewsSignal } from '../../src/news/news-cache.js';
import type { GroundingResult } from '../../src/news/grok-grounder.js';
import type { DbMarketSnapshot } from '../../src/db/types.js';

describe('Full fusion pipeline', () => {
  it('fake pump claim + market ignores = NON-TRADABLE', () => {
    const signals: NewsSignal[] = [{
      coins: ['BTC'],
      direction: 'bullish',
      importance: 8,
      timeframe: 'short',
      catalyst: 'Bitcoin +20k tomorrow',
      reasoning: 'Influencer prediction',
      price_impact: 'high',
      expires_hours: 24,
      source_count: 1,
      conflicting: false,
    }];

    const groundingMap = new Map<string, GroundingResult>([
      ['Bitcoin +20k tomorrow', {
        claim: 'Bitcoin +20k tomorrow',
        verified: false,
        confidence: 0.9,
        summary: 'No credible source confirms. Clickbait.',
        sources: [],
        contradictions: ['No catalyst identified'],
        tokensUsed: 200,
        claimType: 'prediction',
        tradability: 'none',
        sourceQuality: 'influencer',
      }],
    ]);

    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['BTCUSDT', [
        { pair: 'BTCUSDT', mark_price: 104000, open_interest: 5e9, created_at: '2026-03-07T09:55:00Z' },
        { pair: 'BTCUSDT', mark_price: 104050, open_interest: 5e9, created_at: '2026-03-07T10:10:00Z' },
      ]],
    ]);

    const entries = buildNewsMarketFusion(signals, groundingMap, snapshots, '2026-03-07T10:00:00Z');
    expect(entries.length).toBe(1);
    expect(entries[0].grounding?.claimType).toBe('prediction');
    expect(entries[0].grounding?.tradability).toBe('none');
    expect(entries[0].marketReaction.verdict).toBe('IGNORES');

    const text = formatFusionBlock(entries);
    expect(text).toContain('NON-TRADABLE');
    expect(text).toContain('prediction');
  });

  it('real hack + market confirms = MARKET CONFIRMS', () => {
    const signals: NewsSignal[] = [{
      coins: ['ETH'],
      direction: 'bearish',
      importance: 9,
      timeframe: 'short',
      catalyst: 'Major DEX exploit $200M drained',
      reasoning: 'Multiple sources confirm',
      price_impact: 'high',
      expires_hours: 48,
      source_count: 5,
      conflicting: false,
    }];

    const groundingMap = new Map<string, GroundingResult>([
      ['Major DEX exploit $200M drained', {
        claim: 'Major DEX exploit $200M drained',
        verified: true,
        confidence: 0.95,
        summary: 'Confirmed by @PeckShield and @SlowMist',
        sources: ['@PeckShield', '@SlowMist', '@zachxbt'],
        contradictions: [],
        tokensUsed: 300,
        claimType: 'exchange_incident',
        tradability: 'actionable',
        sourceQuality: 'official',
      }],
    ]);

    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['ETHUSDT', [
        { pair: 'ETHUSDT', mark_price: 3500, open_interest: 2e9, created_at: '2026-03-07T09:55:00Z' },
        { pair: 'ETHUSDT', mark_price: 3410, open_interest: 1.8e9, created_at: '2026-03-07T10:10:00Z' },
      ]],
    ]);

    const entries = buildNewsMarketFusion(signals, groundingMap, snapshots, '2026-03-07T10:00:00Z');
    const text = formatFusionBlock(entries);
    expect(text).toContain('MARKET CONFIRMS');
    expect(text).toContain('bearish');
    expect(text).toContain('actionable');
  });

  it('verified news but market fades = MARKET FADES', () => {
    const signals: NewsSignal[] = [{
      coins: ['SOL'],
      direction: 'bullish',
      importance: 7,
      timeframe: 'short',
      catalyst: 'Major partnership announced',
      reasoning: 'Official blog post',
      price_impact: 'medium',
      expires_hours: 48,
      source_count: 3,
      conflicting: false,
    }];

    const groundingMap = new Map<string, GroundingResult>([
      ['Major partnership announced', {
        claim: 'Major partnership announced',
        verified: true,
        confidence: 0.85,
        tokensUsed: 200,
        claimType: 'official_event',
        tradability: 'actionable',
        sourceQuality: 'official',
      }],
    ]);

    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['SOLUSDT', [
        { pair: 'SOLUSDT', mark_price: 200, open_interest: 1e9, created_at: '2026-03-07T09:55:00Z' },
        { pair: 'SOLUSDT', mark_price: 197, open_interest: 0.95e9, created_at: '2026-03-07T10:10:00Z' },
      ]],
    ]);

    const entries = buildNewsMarketFusion(signals, groundingMap, snapshots, '2026-03-07T10:00:00Z');
    const text = formatFusionBlock(entries);
    expect(text).toContain('MARKET FADES');
  });
});
