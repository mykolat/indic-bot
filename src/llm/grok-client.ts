import { fetchWithTimeout } from '../utils/fetch-timeout.js';

export interface GrokHealthResult {
    ok: boolean;
    error?: string;
}

export class GrokClient {
    private emptyKeyWarned = false;

    constructor(private apiKey: string) { }

    async call(systemPrompt: string, userPrompt: string, model: string = 'grok-4-1-fast-reasoning'): Promise<string> {
        if (!this.apiKey) {
            if (!this.emptyKeyWarned) {
                console.warn('[Grok] No API key — all Grok calls will be skipped');
                this.emptyKeyWarned = true;
            }
            return '';
        }
        const res = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1
            })
        }, 15000);

        if (!res.ok) throw new Error(`xAI Error: ${res.status} ${res.statusText}`);
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
    }

    async healthCheck(): Promise<GrokHealthResult> {
        if (!this.apiKey) return { ok: false, error: 'No xAI API key configured' };
        try {
            const res = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: 'grok-4-1-fast-non-reasoning',
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1
                })
            }, 15000);
            if (!res.ok) return { ok: false, error: `xAI Error: ${res.status} ${res.statusText}` };
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: err.message ?? String(err) };
        }
    }
}
