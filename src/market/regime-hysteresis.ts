import { MarketRegime } from './regime-classifier.js';

const BYPASS_REGIMES = new Set([MarketRegime.Capitulation]);

export class RegimeHysteresis {
  private confirmed = new Map<string, MarketRegime>();
  private pending = new Map<string, { regime: MarketRegime; count: number }>();

  constructor(private requiredCycles: number = 3) {}

  update(pair: string, newRegime: MarketRegime): MarketRegime {
    if (BYPASS_REGIMES.has(newRegime)) {
      this.confirmed.set(pair, newRegime);
      this.pending.delete(pair);
      return newRegime;
    }

    const current = this.confirmed.get(pair) ?? MarketRegime.Range;

    // Instant exit from critical regimes (symmetric with instant entry)
    if (BYPASS_REGIMES.has(current) && newRegime !== current) {
      this.confirmed.set(pair, newRegime);
      this.pending.delete(pair);
      return newRegime;
    }

    if (newRegime === current) {
      this.pending.delete(pair);
      return current;
    }

    const p = this.pending.get(pair);
    if (p && p.regime === newRegime) {
      p.count++;
      if (p.count >= this.requiredCycles) {
        this.confirmed.set(pair, newRegime);
        this.pending.delete(pair);
        return newRegime;
      }
    } else {
      this.pending.set(pair, { regime: newRegime, count: 1 });
    }

    return current;
  }

  get(pair: string): MarketRegime {
    return this.confirmed.get(pair) ?? MarketRegime.Range;
  }
}
