/**
 * SwarmBlackboard — shared state for the Blackboard Swarm pattern.
 *
 * All personas read from and write to a single BlackboardState instead of
 * passing sequential messages.  The blackboard tracks market context,
 * aggregated signals, per-persona votes, risk items, and detected conflicts.
 */

// ── Interfaces ──────────────────────────────────────────────────────────

export interface BlackboardMarket {
  pairs: string[];
  regime: string;
  fearGreed: number;
  volumeRatio: number;
  keyLevels?: string[];
}

export interface BlackboardSignals {
  bullish: string[];
  bearish: string[];
  neutral: string[];
}

export interface BlackboardVote {
  d: string;      // HOLD | LONG | SHORT | CLOSE
  c: number;      // confidence 0-100
  prob: number;    // probability_of_success 0-100
  reason: string;  // compact slug
}

export interface BlackboardConflict {
  between: [string, string];
  topic: string;
  severity: 'low' | 'medium' | 'high';
}

export interface BlackboardState {
  market: BlackboardMarket;
  signals: BlackboardSignals;
  votes: Record<string, BlackboardVote>;
  risks: string[];
  conflicts: BlackboardConflict[];
}

export interface PersonaUpdate {
  signals: BlackboardSignals;
  vote: BlackboardVote;
  risks: string[];
  conflicts_with: Record<string, string>;  // { "BT": "reason_slug" }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Add item to array only if it is not already present. */
function addUnique(arr: string[], item: string): void {
  if (!arr.includes(item)) arr.push(item);
}

/** Coerce an LLM-returned value into a string array.
 *  Handles: string → [string], null/undefined → [], array passthrough. */
function coerceArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') return [val];
  return [];
}

/** Classify conflict severity between two votes. */
function classifyConflictSeverity(
  voteA: BlackboardVote,
  voteB: BlackboardVote,
): 'low' | 'medium' | 'high' {
  const dirA = voteA.d;
  const dirB = voteB.d;

  const opposing =
    (dirA === 'LONG' && dirB === 'SHORT') ||
    (dirA === 'SHORT' && dirB === 'LONG');

  if (opposing) {
    return voteA.c >= 60 && voteB.c >= 60 ? 'high' : 'medium';
  }

  return 'low';
}

// ── Class ───────────────────────────────────────────────────────────────

export class SwarmBlackboard {
  private state: BlackboardState;

  constructor(market: BlackboardMarket) {
    this.state = {
      market: structuredClone(market),
      signals: { bullish: [], bearish: [], neutral: [] },
      votes: {},
      risks: [],
      conflicts: [],
    };
  }

  /**
   * Merge a persona's update into the shared blackboard.
   *
   * - Signals are deduplicated across all personas.
   * - The vote is stored (or overwritten) keyed by personaCode.
   * - Risks are deduplicated.
   * - Conflicts are created for every entry in `conflicts_with` where the
   *   opposing persona already has a vote recorded.
   */
  mergePersonaUpdate(personaCode: string, update: PersonaUpdate): void {
    // ── Signals ──
    // LLM may return signals sub-fields as string, null, or undefined
    const sig = update.signals ?? {};
    for (const s of coerceArray(sig.bullish)) addUnique(this.state.signals.bullish, s);
    for (const s of coerceArray(sig.bearish)) addUnique(this.state.signals.bearish, s);
    for (const s of coerceArray(sig.neutral)) addUnique(this.state.signals.neutral, s);

    // ── Vote ──
    this.state.votes[personaCode] = { ...update.vote };

    // ── Risks ──
    // LLM may return risks as a string or null instead of array
    for (const r of coerceArray(update.risks)) addUnique(this.state.risks, r);

    // ── Conflicts ──
    const conflictsWith = update.conflicts_with ?? {};
    for (const [otherCode, topic] of Object.entries(conflictsWith)) {
      const otherVote = this.state.votes[otherCode];
      if (!otherVote) continue;   // can't classify without the other vote

      const severity = classifyConflictSeverity(update.vote, otherVote);
      this.state.conflicts.push({
        between: [personaCode, otherCode],
        topic,
        severity,
      });
    }
  }

  /** Return a deep clone of the current state (safe to mutate externally). */
  getState(): BlackboardState {
    return structuredClone(this.state);
  }

  /** Persona codes involved in at least one medium or high severity conflict. */
  getConflictingSpeakers(): string[] {
    const codes = new Set<string>();
    for (const c of this.state.conflicts) {
      if (c.severity === 'medium' || c.severity === 'high') {
        codes.add(c.between[0]);
        codes.add(c.between[1]);
      }
    }
    return [...codes];
  }

  /** Serialize the full state to a JSON string. */
  toJSON(): string {
    return JSON.stringify(this.state);
  }
}
