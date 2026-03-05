export class FlashCrashScanner {
    constructor(private grokClient: any) { }

    async scan(): Promise<'PANIC' | 'IGNORE'> {
        if (!this.grokClient) return 'IGNORE';

        const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".`;

        try {
            // Speed is critical here
            const raw = await this.grokClient.call(sys, 'Scan crypto X now.', 'grok-4-1-fast-non-reasoning');
            if (raw.trim().toUpperCase().includes('PANIC')) return 'PANIC';
        } catch (e) { /* ignore */ }

        return 'IGNORE';
    }
}
