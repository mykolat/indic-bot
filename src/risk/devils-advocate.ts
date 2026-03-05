export class DevilsAdvocate {
    constructor(private grokClient: any) { }

    async checkTrade(pair: string, side: string): Promise<{ veto: boolean; reason?: string }> {
        if (!this.grokClient) return { veto: false };

        const sys = `You are the Devil's Advocate for crypto trades.
Your job is to search X/Twitter for any reason NOT to enter a ${side} on ${pair} right now.
Respond ONLY with JSON: { "veto": true|false, "reason": "..." }`;
        const user = `Give me a reason to NOT go ${side} on ${pair}.`;

        try {
            const raw = await this.grokClient.call(sys, user, 'grok-4-1-fast-reasoning');
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) { /* ignore */ }

        return { veto: false };
    }
}
