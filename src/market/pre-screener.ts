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

export type MarginMode = 'normal' | 'low_margin' | 'no_margin';

export interface MarginContext {
  availableUsd: number;
  walletBalanceUsd: number;
  minPositionUsd: number;
}

export interface ScreenAllResult {
  passed: ScreenVerdict[];
  held: ScreenVerdict[];
  marginMode: MarginMode;
}

export class PreScreener {
  screen(input: ScreenInput): ScreenVerdict {
    const { pair, ind1h, ind4h, regime, confluence, hasPosition } = input;

    if (hasPosition) {
      return { pair, verdict: 'manage' };
    }

    // BTC always passes — market barometer
    if (pair === 'BTCUSDT') {
      return { pair, verdict: 'pass' };
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

  screenAll(inputs: ScreenInput[], opts?: { exposureFull?: boolean; margin?: MarginContext }): ScreenAllResult {
    let marginMode: MarginMode = 'normal';
    if (opts?.margin) {
      const { availableUsd, walletBalanceUsd, minPositionUsd } = opts.margin;
      if (availableUsd < minPositionUsd) {
        marginMode = 'no_margin';
      } else if (availableUsd < walletBalanceUsd * 0.1) {
        marginMode = 'low_margin';
      }
    }

    const passed: ScreenVerdict[] = [];
    const held: ScreenVerdict[] = [];

    for (const input of inputs) {
      // No margin: only positions + BTC
      if (marginMode === 'no_margin' && !input.hasPosition && input.pair !== 'BTCUSDT') {
        held.push({ pair: input.pair, verdict: 'hold', reason: 'no_margin' });
        continue;
      }

      // If portfolio exposure is already maxed, skip new-position candidates
      if (opts?.exposureFull && !input.hasPosition) {
        held.push({ pair: input.pair, verdict: 'hold', reason: 'exposure_full' });
        continue;
      }
      const result = this.screen(input);
      if (result.verdict === 'hold') {
        held.push(result);
      } else {
        passed.push(result);
      }
    }

    // Safety: if nothing passed, force first pair through
    if (passed.length === 0 && held.length > 0) {
      const forced = held.shift()!;
      passed.push({ ...forced, verdict: 'pass' });
    }

    return { passed, held, marginMode };
  }
}
