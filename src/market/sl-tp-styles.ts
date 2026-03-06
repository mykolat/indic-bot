import type { Indicators } from '../indicators/technical.js';
import type { FilterProfile } from './filter-profiles.js';

export interface SlTpInput {
  slStyle: FilterProfile['slStyle'];
  tpStyle: FilterProfile['tpStyle'];
  slPct: number;
  tpPct: number;
  fillPrice: number;
  side: 'LONG' | 'SHORT';
  indicators: Indicators;
}

export interface SlTpPrices {
  slPrice: number;
  tpPrice: number;
}

export function computeSlTpPrices(input: SlTpInput): SlTpPrices {
  const { slStyle, tpStyle, slPct, tpPct, fillPrice, side, indicators } = input;
  const dir = side === 'LONG' ? 1 : -1;

  let slOffset: number;
  switch (slStyle) {
    case 'atr':
      slOffset = 1.5 * indicators.atr;
      break;
    case 'range':
      slOffset = dir === 1
        ? fillPrice - indicators.bollingerLower
        : indicators.bollingerUpper - fillPrice;
      break;
    case 'trailing':
      slOffset = fillPrice * (slPct * 0.8) / 100;
      break;
    case 'fixed':
    default:
      slOffset = fillPrice * slPct / 100;
      break;
  }

  let tpOffset: number;
  switch (tpStyle) {
    case 'momentum':
      tpOffset = 2 * indicators.atr;
      break;
    case 'range':
      tpOffset = dir === 1
        ? indicators.bollingerUpper - fillPrice
        : fillPrice - indicators.bollingerLower;
      break;
    case 'trailing':
      tpOffset = fillPrice * (tpPct * 1.2) / 100;
      break;
    case 'dca':
      tpOffset = fillPrice * (tpPct * 0.5) / 100;
      break;
    case 'fixed':
    default:
      tpOffset = fillPrice * tpPct / 100;
      break;
  }

  return {
    slPrice: fillPrice - dir * slOffset,
    tpPrice: fillPrice + dir * tpOffset,
  };
}
