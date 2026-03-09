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
    const fresh = await this.ensureFreshToken(best);
    this.currentTokenId = fresh.id!;
    return fresh;
  }

  private async ensureFreshToken(token: DbToken): Promise<DbToken> {
    if (token.auth_type !== 'oauth' || !token.expires_at || !token.refresh_token) return token;

    const expiresAt = new Date(token.expires_at).getTime() / 1000;
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt > now + 60) return token; // still valid

    console.log(`[TokenPool] Refreshing expired token '${token.label}'...`);
    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      }),
    });

    if (!response.ok) {
      console.error(`[TokenPool] Refresh failed for '${token.label}': ${response.status}`);
      await updateTokenError(token.id!, `refresh_failed_${response.status}`).catch(() => {});
      return token;
    }

    const json = (await response.json()) as any;
    const newExpires = new Date((Math.floor(Date.now() / 1000) + (json.expires_in || 3600)) * 1000).toISOString();

    await updateTokenStats(token.id!, {
      primary_used_pct: token.primary_used_pct ?? 0,
      secondary_used_pct: token.secondary_used_pct ?? 0,
      primary_reset_at: token.primary_reset_at ?? null,
      secondary_reset_at: token.secondary_reset_at ?? null,
      last_used_at: new Date().toISOString(),
      access_token: json.access_token,
      expires_at: newExpires,
    }).catch(() => {});

    console.log(`[TokenPool] Token '${token.label}' refreshed successfully`);
    return {
      ...token,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? token.refresh_token,
      expires_at: newExpires,
    };
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
