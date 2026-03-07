/**
 * Market Session Detector
 *
 * Maps UTC time to trading sessions and provides metadata
 * for LLM prompt enrichment. Session context is a WEAK PRIOR —
 * it must be confirmed or rejected by actual market data.
 */

export type MarketSession =
  | 'asia_dead_zone'
  | 'london_open'
  | 'london_continuation'
  | 'london_ny_overlap'
  | 'ny_session'
  | 'ny_close_evening';

export interface SessionMetadata {
  /** Human-readable session name (neutral, no bias) */
  name: string;
  /** UTC hour range, e.g. "00:00–06:00" */
  utcRange: string;
  /** Factual tendencies observed historically */
  typicalTendencies: string[];
  /** Signals that would confirm session-typical behaviour */
  confirmationSignals: string[];
  /** Signals that would reject session-typical behaviour */
  rejectionSignals: string[];
}

const SESSION_META: Record<MarketSession, SessionMetadata> = {
  asia_dead_zone: {
    name: 'Asia Session',
    utcRange: '00:00–06:00',
    typicalTendencies: [
      'Lower volume and narrower ranges compared to London/NY',
      'Price tends to consolidate within prior session range',
      'Spoofing and thin-book wicks more common',
    ],
    confirmationSignals: [
      'Volume below 0.7x 24h average',
      'ATR contracting vs prior 4h candle',
      'Order book depth thin on both sides',
    ],
    rejectionSignals: [
      'Volume spike above 1.5x average (news-driven)',
      'Breakout beyond prior session high/low on rising OI',
      'Macro event (BOJ, PBOC) driving directional flow',
    ],
  },
  london_open: {
    name: 'London Open',
    utcRange: '06:00–10:00',
    typicalTendencies: [
      'Liquidity injection as European desks come online',
      'Often sets the directional bias for the day',
      'Stop hunts on Asia session range extremes are common',
    ],
    confirmationSignals: [
      'Volume rising above 1.2x average in first hour',
      'Clear break and hold beyond Asia range',
      'OI increasing alongside price movement',
    ],
    rejectionSignals: [
      'Volume remains low despite session start',
      'Price fails to break Asia range and reverses',
      'Divergence between price direction and OI change',
    ],
  },
  london_continuation: {
    name: 'London Continuation',
    utcRange: '10:00–13:00',
    typicalTendencies: [
      'Trend established at London open tends to extend',
      'Pullbacks to VWAP or EMA20 can offer continuation entries',
      'Volume may taper ahead of NY open',
    ],
    confirmationSignals: [
      'Price holding above/below VWAP in direction of London open move',
      'ADX rising or sustained above 20',
      'Funding rate aligning with trend direction',
    ],
    rejectionSignals: [
      'Price reverses through VWAP with volume',
      'ADX declining below 15',
      'OI dropping while price extends — profit-taking, not new positioning',
    ],
  },
  london_ny_overlap: {
    name: 'London / NY Overlap',
    utcRange: '13:00–17:00',
    typicalTendencies: [
      'Highest participation window — both London and NY desks active',
      'Largest moves and highest volume of the day typically occur here',
      'Reversals of the London trend can happen as NY participants reposition',
    ],
    confirmationSignals: [
      'Volume above 1.5x 24h average',
      'OI expanding with clear directional move',
      'Order book imbalance aligning with price direction',
    ],
    rejectionSignals: [
      'Volume fails to pick up despite overlap window',
      'Choppy price action with no sustained direction',
      'Conflicting signals between spot and perp markets',
    ],
  },
  ny_session: {
    name: 'NY Session',
    utcRange: '17:00–21:00',
    typicalTendencies: [
      'US equities close at 20:00 UTC — crypto may react to equity settlement',
      'Trend continuation or late-day mean reversion common',
      'Institutional flows taper toward end of session',
    ],
    confirmationSignals: [
      'Volume sustained above 1.0x average',
      'BTC and equity indices moving in correlation',
      'OI stable or growing — positions being held into close',
    ],
    rejectionSignals: [
      'Volume dropping sharply after 19:00 UTC',
      'BTC decoupling from equity direction on no news',
      'Large OI reduction — position unwinds ahead of off-hours',
    ],
  },
  ny_close_evening: {
    name: 'NY Close / Evening',
    utcRange: '21:00–00:00',
    typicalTendencies: [
      'Liquidity thins as US desks wind down',
      'Moves tend to be smaller and less sustained',
      'Positioning ahead of Asia session; funding rate settlement effects',
    ],
    confirmationSignals: [
      'Volume declining toward 0.6–0.8x average',
      'Price range narrowing into a consolidation',
      'Funding rate approaching settlement — watch for rate-driven moves',
    ],
    rejectionSignals: [
      'Unexpected volume surge (breaking news, hack, regulatory)',
      'Large OI spike — new positions being opened off-hours',
      'Price breaking out of consolidation with follow-through',
    ],
  },
};

/**
 * Maps a UTC date to its market session.
 */
export function getMarketSession(nowUtc: Date): MarketSession {
  const hour = nowUtc.getUTCHours();

  if (hour < 6) return 'asia_dead_zone';
  if (hour < 10) return 'london_open';
  if (hour < 13) return 'london_continuation';
  if (hour < 17) return 'london_ny_overlap';
  if (hour < 21) return 'ny_session';
  return 'ny_close_evening';
}

/**
 * Returns structured metadata for a given session.
 */
export function getSessionMetadata(session: MarketSession): SessionMetadata {
  return SESSION_META[session];
}

/**
 * Formats a prompt block for LLM injection.
 *
 * The block uses neutral language, presents session context as a
 * weak prior, and requires the LLM to explicitly assess whether
 * current data confirms, contradicts, or makes the context irrelevant.
 */
export function formatSessionPromptBlock(nowUtc: Date): string {
  const session = getMarketSession(nowUtc);
  const meta = getSessionMetadata(session);

  const tendencies = meta.typicalTendencies.map((t) => `  - ${t}`).join('\n');
  const confirms = meta.confirmationSignals.map((s) => `  - ${s}`).join('\n');
  const rejects = meta.rejectionSignals.map((s) => `  - ${s}`).join('\n');

  return [
    `=== Market Session Context (weak prior) ===`,
    `Session: ${meta.name} (${meta.utcRange} UTC)`,
    ``,
    `Typical tendencies (historical, not predictive):`,
    tendencies,
    ``,
    `Confirm with:`,
    confirms,
    ``,
    `Reject if:`,
    rejects,
    ``,
    `NOTE: This session context is a weak prior. Current price action, volume,`,
    `and order flow data can confirm, contradict, or make this session context irrelevant.`,
    `You MUST explicitly state whether the live data confirm, contradict, or make this session context irrelevant.`,
  ].join('\n');
}
