import { fetchWithTimeout } from '../utils/fetch-timeout.js';

export class GrokClient {
    constructor(private apiKey: string) { }

    async call(systemPrompt: string, userPrompt: string, model: string = 'grok-4-1-fast-reasoning'): Promise<string> {
        if (!this.apiKey) return '';
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

        if (!res.ok) throw new Error(`xAI Error: ${res.statusText}`);
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
    }
}
