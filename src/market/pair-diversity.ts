export interface PairDecisionEntry {
  pair: string;
  cycle: number;
}

export function buildDiversityContext(
  history: PairDecisionEntry[],
  allPairs: string[],
  currentCycle?: number,
): string {
  if (history.length === 0) return '';

  const cycle = currentCycle ?? Math.max(...history.map(h => h.cycle));
  const lines: string[] = ['### PAIR SELECTION HISTORY'];

  // Last trade cycle per pair
  const lastCycle = new Map<string, number>();
  for (const h of history) {
    const prev = lastCycle.get(h.pair);
    if (!prev || h.cycle > prev) lastCycle.set(h.pair, h.cycle);
  }

  for (const pair of allPairs) {
    const last = lastCycle.get(pair);
    if (last != null) {
      lines.push(`${pair}: ${cycle - last} cycles ago`);
    } else {
      lines.push(`${pair}: never traded`);
    }
  }

  // Concentration warning
  const counts = new Map<string, number>();
  for (const h of history) counts.set(h.pair, (counts.get(h.pair) ?? 0) + 1);
  const total = history.length;
  for (const [pair, count] of counts) {
    const pct = Math.round((count / total) * 100);
    if (pct > 50) {
      lines.push(`WARNING: ${pair} is ${pct}% of recent trades. Consider other pairs.`);
    }
  }

  return lines.join('\n');
}
