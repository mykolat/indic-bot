import { fetchWithTimeout } from '../utils/fetch-timeout.js';

const CHAT_URL = 'https://api.x.ai/v1/chat/completions';
const RESPONSES_URL = 'https://api.x.ai/v1/responses';

export interface GrokHealthResult {
    ok: boolean;
    error?: string;
}

export class GrokClient {
    private emptyKeyWarned = false;

    constructor(private apiKey: string) { }

    async call(
        systemPrompt: string,
        userPrompt: string,
        model: string = 'grok-4-1-fast-non-reasoning',
        options?: { search?: boolean; temperature?: number },
    ): Promise<string> {
        if (!this.apiKey) {
            if (!this.emptyKeyWarned) {
                console.warn('[Grok] No API key — all Grok calls will be skipped');
                this.emptyKeyWarned = true;
            }
            return '';
        }

        // Use /v1/responses with tools for search, /v1/chat/completions otherwise
        if (options?.search) {
            return this.callWithTools(systemPrompt, userPrompt, model, options.temperature);
        }

        const body: Record<string, unknown> = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: options?.temperature ?? 0.1,
        };
        const res = await fetchWithTimeout(CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        }, 15_000);

        if (!res.ok) throw new Error(`xAI Error: ${res.status} ${res.statusText}`);
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
    }

    /**
     * Call Grok via /v1/responses with web_search + x_search tools.
     * Replaces deprecated search_parameters.
     */
    private async callWithTools(
        systemPrompt: string,
        userPrompt: string,
        model: string,
        temperature?: number,
    ): Promise<string> {
        const body = {
            model,
            input: [
                { role: 'system' as const, content: systemPrompt },
                { role: 'user' as const, content: userPrompt },
            ],
            tools: [
                { type: 'web_search' },
                { type: 'x_search' },
            ],
            temperature: temperature ?? 0.1,
        };

        const res = await fetchWithTimeout(RESPONSES_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        }, 30_000);

        // 410 Gone = search tools deprecated — retry without tools
        if (res.status === 410) {
            console.warn('[Grok] 410 Gone — search tools deprecated, retrying without tools');
            const { tools: _tools, ...bodyWithoutTools } = body;
            const retryRes = await fetchWithTimeout(RESPONSES_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(bodyWithoutTools),
            }, 30_000);

            if (!retryRes.ok) {
                const errText = await retryRes.text().catch(() => '');
                throw new Error(`xAI Error: ${retryRes.status} ${errText.slice(0, 200)}`);
            }
            const retryData = await retryRes.json() as any;
            if (retryData.output_text) return retryData.output_text;
            if (Array.isArray(retryData.output)) {
                const msg = retryData.output.find((o: any) => o.type === 'message');
                if (msg?.content?.[0]?.text) return msg.content[0].text;
            }
            return '';
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`xAI Error: ${res.status} ${errText.slice(0, 200)}`);
        }
        const data = await res.json() as any;
        // /v1/responses returns output_text or output array
        if (data.output_text) return data.output_text;
        if (Array.isArray(data.output)) {
            const msg = data.output.find((o: any) => o.type === 'message');
            if (msg?.content?.[0]?.text) return msg.content[0].text;
        }
        return '';
    }

    async healthCheck(): Promise<GrokHealthResult> {
        if (!this.apiKey) return { ok: false, error: 'No xAI API key configured' };
        try {
            const res = await fetchWithTimeout(CHAT_URL, {
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
