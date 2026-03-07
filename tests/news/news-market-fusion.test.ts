import { describe, it, expect } from 'vitest';
import {
  buildNewsMarketFusion,
  formatFusionBlock,
  type FusionEntry,
} from '../../src/news/news-market-fusion.js';
import type { NewsSignal } from '../../src/news/news-cache.js';
import type { GroundingResult } from '../../src/news/grok-grounder.js';
import type { DbMarketSnapshot } from '../../src/db/types.js';

function makeSignal(overrides: Partial<NewsSignal> = {}): NewsSignal {
  return {
    coins: ['BTC'],
    direction: 'bullish',
    importance: 7,
    timeframe: 'short',
    catalyst: 'ETF approval rumor',
    reasoning: 'Multiple sources reporting',
    price_impact: 'high',
    expires_hours: 4,
    source_count: 3,
    conflicting: false,
    ...overrides,
  };
}

function makeGrounding(overrides: Partial<GroundingResult> = {}): GroundingResult {
  return {
    claim: 'ETF approval rumor',
    verified: true,
    confidence: 0.8,
    summary: 'Bloomberg confirmed ETF filing accepted',
    sources: ['@Bloomberg'],
    contradictions: [],
    tokensUsed: 500,
    claimType: 'rumor',
    tradability: 'actionable',
    sourceQuality: 'mainstream_media',
    ...overrides,
  };
}

function makeSnapshots(pair: string, eventTime: string): DbMarketSnapshot[] {
  const eventTs = new Date(eventTime).getTime();
  return [
    {
      pair,
      mark_price: 60000,
      open_interest: 1000000,
      funding_rate: 0.01,
      imbalance_pct: 5,
      created_at: new Date(eventTs - 60000).toISOString(),
    },
    {
      pair,
      mark_price: 60500, // +0.83% → CONFIRMS bullish
      open_interest: 1050000,
      funding_rate: 0.01,
      imbalance_pct: 10,
      created_at: new Date(eventTs + 60000).toISOString(),
    },
  ];
}

describe('buildNewsMarketFusion', () => {
  const eventTime = '2026-03-07T12:00:00Z';

  it('produces fusion entries correlating signals with market reaction', () => {
    const signals = [makeSignal()];
    const grounding = new Map([['ETF approval rumor', makeGrounding()]]);
    const snapshots = new Map([['BTCUSDT', makeSnapshots('BTCUSDT', eventTime)]]);

    const entries = buildNewsMarketFusion(signals, grounding, snapshots, eventTime);

    expect(entries).toHaveLength(1);
    expect(entries[0].pair).toBe('BTCUSDT');
    expect(entries[0].signal.catalyst).toBe('ETF approval rumor');
    expect(entries[0].grounding).toBeDefined();
    expect(entries[0].grounding!.verified).toBe(true);
    expect(entries[0].marketReaction.verdict).toBe('CONFIRMS');
  });

  it('returns empty array when no high-importance signals', () => {
    const signals = [makeSignal({ importance: 3 })];
    const grounding = new Map<string, GroundingResult>();
    const snapshots = new Map<string, DbMarketSnapshot[]>();

    const entries = buildNewsMarketFusion(signals, grounding, snapshots, eventTime);

    expect(entries).toHaveLength(0);
  });

  it('uses BTCUSDT as proxy when signal.coins is empty', () => {
    const signals = [makeSignal({ coins: [], catalyst: 'Fed rate cut' })];
    const grounding = new Map<string, GroundingResult>();
    const snapshots = new Map([['BTCUSDT', makeSnapshots('BTCUSDT', eventTime)]]);

    const entries = buildNewsMarketFusion(signals, grounding, snapshots, eventTime);

    expect(entries).toHaveLength(1);
    expect(entries[0].pair).toBe('BTCUSDT');
    expect(entries[0].marketReaction.verdict).toBe('CONFIRMS');
  });

  it('handles missing grounding gracefully', () => {
    const signals = [makeSignal({ catalyst: 'Some ungrounded claim' })];
    const grounding = new Map<string, GroundingResult>(); // empty
    const snapshots = new Map([['BTCUSDT', makeSnapshots('BTCUSDT', eventTime)]]);

    const entries = buildNewsMarketFusion(signals, grounding, snapshots, eventTime);

    expect(entries).toHaveLength(1);
    expect(entries[0].grounding).toBeUndefined();
    expect(entries[0].marketReaction.verdict).toBe('CONFIRMS');
  });

  it('resolves pair by appending USDT if needed', () => {
    const signals = [makeSignal({ coins: ['ETH'] })];
    const grounding = new Map<string, GroundingResult>();
    const snapshots = new Map([['ETHUSDT', makeSnapshots('ETHUSDT', eventTime)]]);

    const entries = buildNewsMarketFusion(signals, grounding, snapshots, eventTime);

    expect(entries).toHaveLength(1);
    expect(entries[0].pair).toBe('ETHUSDT');
  });

  it('produces multiple entries for multi-coin signals', () => {
    const signals = [makeSignal({ coins: ['BTC', 'ETH'] })];
    const grounding = new Map<string, GroundingResult>();
    const snapshots = new Map([
      ['BTCUSDT', makeSnapshots('BTCUSDT', eventTime)],
      ['ETHUSDT', makeSnapshots('ETHUSDT', eventTime)],
    ]);

    const entries = buildNewsMarketFusion(signals, grounding, snapshots, eventTime);

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.pair)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});

describe('formatFusionBlock', () => {
  it('returns empty string when entries empty', () => {
    expect(formatFusionBlock([])).toBe('');
  });

  it('formats fusion block as prompt text with catalyst, verdict, direction', () => {
    const entries: FusionEntry[] = [
      {
        signal: makeSignal(),
        grounding: makeGrounding(),
        marketReaction: {
          verdict: 'CONFIRMS',
          priceDisplacementPct: 0.83,
          oiChangePct: 5.0,
          fundingFlipped: false,
          imbalanceShift: 5,
          summary: 'CONFIRMS: price +0.83%, OI +5.0%',
        },
        pair: 'BTCUSDT',
      },
    ];

    const block = formatFusionBlock(entries);

    expect(block).toContain('## Event Impact (news + market correlation)');
    expect(block).toContain('ETF approval rumor');
    expect(block).toContain('importance 7');
    expect(block).toContain('bullish');
    expect(block).toContain('Grounding: VERIFIED');
    expect(block).toContain('Bloomberg confirmed ETF filing accepted');
    expect(block).toContain('BTCUSDT');
    expect(block).toContain('CONFIRMS');
    expect(block).toContain('>> MARKET CONFIRMS');
    expect(block).toContain('consider bullish bias');
  });

  it('shows NON-TRADABLE for predictions', () => {
    const entries: FusionEntry[] = [
      {
        signal: makeSignal({ catalyst: 'BTC to 100k prediction' }),
        grounding: makeGrounding({
          claimType: 'prediction',
          tradability: 'none',
          claim: 'BTC to 100k prediction',
        }),
        marketReaction: {
          verdict: 'CONFIRMS',
          priceDisplacementPct: 0.5,
          oiChangePct: 0,
          fundingFlipped: false,
          imbalanceShift: 0,
          summary: 'CONFIRMS: price +0.50%',
        },
        pair: 'BTCUSDT',
      },
    ];

    const block = formatFusionBlock(entries);

    expect(block).toContain('>> NON-TRADABLE: prediction');
    expect(block).toContain('ignore for positioning');
  });

  it('shows MARKET FADES for fading verdict', () => {
    const entries: FusionEntry[] = [
      {
        signal: makeSignal({ direction: 'bullish' }),
        grounding: makeGrounding({ tradability: 'actionable', claimType: 'official_event' }),
        marketReaction: {
          verdict: 'FADES',
          priceDisplacementPct: -1.2,
          oiChangePct: -2,
          fundingFlipped: false,
          imbalanceShift: -3,
          summary: 'FADES: price -1.20%, OI -2.0%',
        },
        pair: 'BTCUSDT',
      },
    ];

    const block = formatFusionBlock(entries);

    expect(block).toContain('>> MARKET FADES this claim');
    expect(block).toContain('do NOT follow the narrative');
  });

  it('shows MARKET IGNORES for ignoring verdict', () => {
    const entries: FusionEntry[] = [
      {
        signal: makeSignal(),
        grounding: makeGrounding({ tradability: 'actionable', claimType: 'official_event' }),
        marketReaction: {
          verdict: 'IGNORES',
          priceDisplacementPct: 0.1,
          oiChangePct: 0,
          fundingFlipped: false,
          imbalanceShift: 0,
          summary: 'IGNORES: price +0.10%',
        },
        pair: 'BTCUSDT',
      },
    ];

    const block = formatFusionBlock(entries);

    expect(block).toContain('>> MARKET IGNORES');
    expect(block).toContain('no edge yet, watch only');
  });

  it('shows DEBUNKED status from grounding', () => {
    const entries: FusionEntry[] = [
      {
        signal: makeSignal(),
        grounding: makeGrounding({ verified: false, summary: 'Fake news debunked by Binance' }),
        marketReaction: {
          verdict: 'CONFIRMS',
          priceDisplacementPct: 0.8,
          oiChangePct: 1,
          fundingFlipped: false,
          imbalanceShift: 0,
          summary: 'CONFIRMS: price +0.80%',
        },
        pair: 'BTCUSDT',
      },
    ];

    const block = formatFusionBlock(entries);

    expect(block).toContain('Grounding: DEBUNKED');
    // Debunked should not show MARKET CONFIRMS even if verdict is CONFIRMS
    expect(block).not.toContain('>> MARKET CONFIRMS');
  });

  it('omits grounding line when grounding is undefined', () => {
    const entries: FusionEntry[] = [
      {
        signal: makeSignal(),
        grounding: undefined,
        marketReaction: {
          verdict: 'CONFIRMS',
          priceDisplacementPct: 0.8,
          oiChangePct: 1,
          fundingFlipped: false,
          imbalanceShift: 0,
          summary: 'CONFIRMS: price +0.80%',
        },
        pair: 'BTCUSDT',
      },
    ];

    const block = formatFusionBlock(entries);

    expect(block).not.toContain('Grounding:');
    expect(block).toContain('>> MARKET CONFIRMS');
  });
});
