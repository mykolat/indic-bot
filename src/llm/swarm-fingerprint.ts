interface FingerprintInput {
  positions: Array<{ pair: string; side: string; unrealizedPnlPct: number }>;
  regime: string;
  volumeRatio: number;
  fearGreedValue: number;
}

/**
 * Build a string fingerprint of the market state relevant to swarm decisions.
 * Quantizes continuous values into buckets so small noise doesn't trigger re-debate.
 */
export function buildSwarmFingerprint(input: FingerprintInput): string {
  const posPart = input.positions
    .map(p => `${p.pair}:${p.side}:${Math.round(p.unrealizedPnlPct)}`)
    .sort()
    .join('|');

  const fgBucket = Math.floor(input.fearGreedValue / 20); // 0-4 buckets
  const volBucket = input.volumeRatio < 1 ? 'low' : input.volumeRatio < 2 ? 'mid' : 'high';

  return `${posPart};;${input.regime};;${volBucket};;fg${fgBucket}`;
}

/**
 * Returns true if the fingerprint has materially changed.
 */
export function hasChanged(prev: string, current: string): boolean {
  return prev !== current;
}
