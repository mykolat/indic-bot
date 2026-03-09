import { getActiveTokens, updateTokenStats, updateTokenError } from '../db/repository.js';
import type { DbToken } from '../db/types.js';

const PRIMARY_THRESHOLD = 90;
const SECONDARY_THRESHOLD = 95;
const ROTATION_PRIMARY = 80;
const ROTATION_SECONDARY = 85;

export interface RateLimitStats {
  primary_used_pct: number;
  secondary_used_pct: number;
  primary_reset_at: string | null;
  secondary_reset_at: string | null;
}

export class TokenPool {
  private currentTokenId: number | null = null;

  async getBestToken(provider: string): Promise<DbToken | null> {
    const tokens = await getActiveTokens(provider);
    const eligible = tokens.filter(t =>
      (t.primary_used_pct ?? 0) < PRIMARY_THRESHOLD &&
      (t.secondary_used_pct ?? 0) < SECONDARY_THRESHOLD,
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => (a.secondary_used_pct ?? 0) - (b.secondary_used_pct ?? 0));
    const best = eligible[0];
    this.currentTokenId = best.id!;
    return best;
  }

  getCurrentTokenId(): number | null {
    return this.currentTokenId;
  }

  parseRateLimitHeaders(headers: Map<string, string> | Record<string, string>): RateLimitStats {
    const get = (key: string): string | undefined =>
      headers instanceof Map ? headers.get(key) : headers[key];

    const primaryResetAt = get('x-codex-primary-reset-at');
    const secondaryResetAt = get('x-codex-secondary-reset-at');

    return {
      primary_used_pct: parseInt(get('x-codex-primary-used-percent') ?? '0', 10),
      secondary_used_pct: parseInt(get('x-codex-secondary-used-percent') ?? '0', 10),
      primary_reset_at: primaryResetAt
        ? new Date(parseInt(primaryResetAt, 10) * 1000).toISOString()
        : null,
      secondary_reset_at: secondaryResetAt
        ? new Date(parseInt(secondaryResetAt, 10) * 1000).toISOString()
        : null,
    };
  }

  needsRotation(stats: Pick<RateLimitStats, 'primary_used_pct' | 'secondary_used_pct'>): boolean {
    return stats.primary_used_pct > ROTATION_PRIMARY ||
           stats.secondary_used_pct > ROTATION_SECONDARY;
  }

  async updateStats(tokenId: number, headers: Map<string, string> | Record<string, string>): Promise<RateLimitStats> {
    const stats = this.parseRateLimitHeaders(headers);
    await updateTokenStats(tokenId, {
      ...stats,
      last_used_at: new Date().toISOString(),
    }).catch(() => {});
    return stats;
  }

  async rotateOnError(tokenId: number, error: string): Promise<DbToken | null> {
    await updateTokenError(tokenId, error).catch(() => {});
    return this.getBestToken('codex');
  }
}
