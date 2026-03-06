import type { SourceHealthMonitor } from './source-health.js';

export interface FlashCrashResult {
  verdict: 'PANIC' | 'UNCONFIRMED' | 'IGNORE';
  grokSays: 'PANIC' | 'IGNORE';
  priceDropPct?: number;
  volumeSpike?: number;
  reason: string;
}

export class FlashCrashScanner {
    private lastPanicAt = 0;
    private cooldownMs = 15 * 60_000; // 15 min

    constructor(
      private grokClient: any,
      private sourceHealth?: SourceHealthMonitor,
    ) { }

    async scan(
      marketData?: { getRecentCandles: (pair: string, interval?: string, limit?: number) => Promise<any[]> },
      pairs?: string[],
    ): Promise<FlashCrashResult> {
        if (!this.grokClient) return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: 'no grok client' };

        // Cooldown check
        if (Date.now() - this.lastPanicAt < this.cooldownMs) {
          return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: 'cooldown active' };
        }

        const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".`;

        let grokSays: 'PANIC' | 'IGNORE' = 'IGNORE';
        try {
            const raw = await this.grokClient.call(sys, 'Scan crypto X now.', 'grok-4-1-fast-non-reasoning');
            this.sourceHealth?.recordSuccess('grok-flash-crash');
            grokSays = raw.trim().toUpperCase().includes('PANIC') ? 'PANIC' : 'IGNORE';
        } catch (e: any) {
            const msg = e?.message ?? 'unknown';
            console.warn(`[FlashCrash] Grok scan failed: ${msg}`);
            this.sourceHealth?.recordFailure('grok-flash-crash', msg);
            return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: `grok error: ${msg}` };
        }

        if (grokSays === 'IGNORE') {
          return { verdict: 'IGNORE', grokSays: 'IGNORE', reason: 'grok says IGNORE' };
        }

        // Grok says PANIC — confirm with price data
        if (!marketData || !pairs?.length) {
          return { verdict: 'UNCONFIRMED', grokSays: 'PANIC', reason: 'no market data for confirmation' };
        }

        let signals = 0;
        signals++; // Grok PANIC = 1 signal

        let maxDrop = 0;
        let maxVolSpike = 0;
        try {
          const btcPair = pairs.find(p => p.includes('BTC')) || pairs[0];
          const candles = await marketData.getRecentCandles(btcPair, '1m', 5);
          if (candles.length >= 2) {
            const firstClose = parseFloat(candles[0].close);
            const lastClose = parseFloat(candles[candles.length - 1].close);
            maxDrop = ((lastClose - firstClose) / firstClose) * 100;

            const avgVol = candles.slice(0, -1).reduce((s: number, c: any) => s + parseFloat(c.volume), 0) / Math.max(candles.length - 1, 1);
            const lastVol = parseFloat(candles[candles.length - 1].volume);
            maxVolSpike = avgVol > 0 ? lastVol / avgVol : 0;
          }
        } catch { /* market data optional */ }

        if (maxDrop < -3) signals++;
        if (maxVolSpike > 3) signals++;

        if (signals >= 2) {
          this.lastPanicAt = Date.now();
          return {
            verdict: 'PANIC',
            grokSays: 'PANIC',
            priceDropPct: maxDrop,
            volumeSpike: maxVolSpike,
            reason: `Confirmed: Grok PANIC + ${maxDrop < -3 ? 'price drop' : 'volume spike'}`,
          };
        }

        return {
          verdict: 'UNCONFIRMED',
          grokSays: 'PANIC',
          priceDropPct: maxDrop,
          volumeSpike: maxVolSpike,
          reason: `Grok PANIC but price ${maxDrop.toFixed(1)}%, vol ${maxVolSpike.toFixed(1)}x — insufficient confirmation`,
        };
    }
}
