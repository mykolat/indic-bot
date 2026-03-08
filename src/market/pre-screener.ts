import { getFilterProfile } from './filter-profiles.js';
import { MarketRegime } from './regime-classifier.js';

export interface ScreenInput {
  pair: string;
  ind1h: any | null;
  ind4h: any | null;
  regime: string;
  confluence: number;
  hasPosition: boolean;
}

export interface ScreenVerdict {
  pair: string;
  verdict: 'pass' | 'hold' | 'manage';
  reason?: string;
}

export interface ScreenAllResult {
  passed: ScreenVerdict[];
  held: ScreenVerdict[];
}

export class PreScreener {
  screen(input: ScreenInput): ScreenVerdict {
    const { pair, ind1h, ind4h, regime, confluence, hasPosition } = input;

    if (hasPosition) {
      return { pair, verdict: 'manage' };
    }

    if (!ind1h) {
      return { pair, verdict: 'hold', reason: 'no_data' };
    }

    const profile = getFilterProfile(regime as MarketRegime);
    if (!profile) {
      return { pair, verdict: 'pass' };
    }

    if (ind4h && ind1h.trend !== 'neutral' && ind4h.trend !== 'neutral' && ind1h.trend !== ind4h.trend) {
      return { pair, verdict: 'hold', reason: '4h_conflict' };
    }

    if (ind1h.volumeRatio < profile.volumeMin) {
      return { pair, verdict: 'hold', reason: 'low_volume' };
    }

    if (ind1h.rsi < profile.rsiRange[0] || ind1h.rsi > profile.rsiRange[1]) {
      return { pair, verdict: 'hold', reason: 'rsi_extreme' };
    }

    if (confluence < profile.confluenceMin) {
      return { pair, verdict: 'hold', reason: 'low_confluence' };
    }

    return { pair, verdict: 'pass' };
  }

  screenAll(inputs: ScreenInput[]): ScreenAllResult {
    const passed: ScreenVerdict[] = [];
    const held: ScreenVerdict[] = [];

    for (const input of inputs) {
      const result = this.screen(input);
      if (result.verdict === 'hold') {
        held.push(result);
      } else {
        passed.push(result);
      }
    }

    return { passed, held };
  }
}
