export interface CandidateEpisode {
  pair: string;
  side: 'LONG' | 'SHORT';
  setupType: string;
  regime: string;
  entryScore: number;
  price: number;
  firstSeen: number;
  lastUpdated: number;
  ttlMs: number;
}

interface AddInput {
  pair: string;
  side: string;
  setupType: string;
  regime: string;
  entryScore: number;
  price: number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 min

export class OpportunityCache {
  private episodes = new Map<string, CandidateEpisode>();

  private key(pair: string, side: string, setupType: string, regime: string): string {
    return `${pair}:${side}:${setupType}:${regime}`;
  }

  add(input: AddInput): void {
    const k = this.key(input.pair, input.side, input.setupType, input.regime);
    const existing = this.episodes.get(k);
    const now = Date.now();

    this.episodes.set(k, {
      pair: input.pair,
      side: input.side as 'LONG' | 'SHORT',
      setupType: input.setupType,
      regime: input.regime,
      entryScore: input.entryScore,
      price: input.price,
      firstSeen: existing?.firstSeen ?? now,
      lastUpdated: now,
      ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    });
  }

  get(pair: string, side: string, setupType: string, regime: string): CandidateEpisode | undefined {
    const k = this.key(pair, side, setupType, regime);
    const ep = this.episodes.get(k);
    if (!ep) return undefined;
    if (Date.now() - ep.firstSeen > ep.ttlMs) {
      this.episodes.delete(k);
      return undefined;
    }
    return ep;
  }

  getActiveCandidates(): CandidateEpisode[] {
    const now = Date.now();
    const active: CandidateEpisode[] = [];
    for (const [k, ep] of this.episodes) {
      if (now - ep.firstSeen > ep.ttlMs) {
        this.episodes.delete(k);
      } else {
        active.push(ep);
      }
    }
    return active.sort((a, b) => b.entryScore - a.entryScore);
  }

  invalidateByRegime(newRegime: string): void {
    for (const [k, ep] of this.episodes) {
      if (ep.regime !== newRegime) {
        this.episodes.delete(k);
      }
    }
  }

  clear(): void {
    this.episodes.clear();
  }
}
