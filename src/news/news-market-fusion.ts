import { computeMarketReaction, type MarketReaction } from './market-reaction.js';
import type { NewsSignal } from './news-cache.js';
import type { GroundingResult } from './grok-grounder.js';
import type { DbMarketSnapshot } from '../db/types.js';

export interface FusionEntry {
  signal: NewsSignal;
  grounding: GroundingResult | undefined;
  marketReaction: MarketReaction;
  pair: string;
}

const MIN_IMPORTANCE = 5;

function resolvePair(coin: string): string {
  return coin.endsWith('USDT') ? coin : `${coin}USDT`;
}

export function buildNewsMarketFusion(
  signals: NewsSignal[],
  groundingResults: Map<string, GroundingResult>,
  pairSnapshots: Map<string, DbMarketSnapshot[]>,
  newsAnalyzedAt: string,
): FusionEntry[] {
  const entries: FusionEntry[] = [];

  for (const signal of signals) {
    if (signal.importance < MIN_IMPORTANCE) continue;

    const grounding = groundingResults.get(signal.catalyst);
    const coins = signal.coins.length > 0 ? signal.coins : ['BTC'];

    for (const coin of coins) {
      const pair = resolvePair(coin);
      const snapshots = pairSnapshots.get(pair) ?? [];
      const marketReaction = computeMarketReaction(snapshots, newsAnalyzedAt, signal.direction);

      entries.push({ signal, grounding, marketReaction, pair });
    }
  }

  return entries;
}

function groundingVerdict(g: GroundingResult): string {
  if (g.verified === true) return 'VERIFIED';
  if (g.verified === false) return 'DEBUNKED';
  return 'UNVERIFIED';
}

export function formatFusionBlock(entries: FusionEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = ['## Event Impact (news + market correlation)\n'];

  for (const entry of entries) {
    const { signal, grounding, marketReaction, pair } = entry;

    // Catalyst header
    lines.push(`- "${signal.catalyst}" (importance ${signal.importance}, ${signal.direction})`);

    // Grounding line
    if (grounding) {
      const verdict = groundingVerdict(grounding);
      const parts = [verdict];
      if (grounding.claimType) parts.push(grounding.claimType);
      if (grounding.tradability) parts.push(`tradability: ${grounding.tradability}`);
      if (grounding.sourceQuality) parts.push(`source: ${grounding.sourceQuality}`);
      lines.push(`  Grounding: ${parts.join(', ')}`);

      if (grounding.summary) {
        lines.push(`  "${grounding.summary}"`);
      }
    }

    // Market reaction
    lines.push(`  ${pair} reaction: ${marketReaction.summary}`);

    // Actionable interpretation
    if (grounding && (grounding.tradability === 'none' || grounding.claimType === 'prediction')) {
      lines.push(`  >> NON-TRADABLE: ${grounding.claimType} — ignore for positioning`);
    } else if (grounding && grounding.verified === false) {
      // Debunked — do not recommend following
      lines.push(`  >> DEBUNKED — do NOT follow the narrative`);
    } else if (marketReaction.verdict === 'CONFIRMS') {
      lines.push(`  >> MARKET CONFIRMS — consider ${signal.direction} bias`);
    } else if (marketReaction.verdict === 'FADES') {
      lines.push(`  >> MARKET FADES this claim — do NOT follow the narrative`);
    } else {
      lines.push(`  >> MARKET IGNORES — no edge yet, watch only`);
    }
  }

  return lines.join('\n');
}
