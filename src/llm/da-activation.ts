import type { BlackboardVote } from './swarm-blackboard.js';

export function shouldActivateDA(votes: Record<string, BlackboardVote>): boolean {
  const dirs = Object.values(votes).map(v => v.d);
  const actionCount = dirs.filter(d => d === 'LONG' || d === 'SHORT').length;
  const closeCount = dirs.filter(d => d === 'CLOSE').length;

  if (actionCount === 1) return true;
  if (closeCount > 0 && actionCount <= 1) return true;
  return false;
}
