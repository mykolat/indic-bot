/**
 * Quick Gemini API test script.
 * Usage: npx tsx scripts/test-gemini.ts
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set in environment');
    process.exit(1);
}

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS_TO_TEST = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-pro-preview',
];

async function testModel(model: string): Promise<void> {
    const url = `${BASE_URL}/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const start = Date.now();

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [
                {
                    role: 'user',
                    parts: [{ text: 'BTC is at $98,500. Fear & Greed index is 22. Should I go LONG or SHORT? Reply in 1 sentence with your reasoning.' }],
                },
            ],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 256,
            },
        }),
    });

    const elapsed = Date.now() - start;

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[${model}] ERROR ${res.status}: ${errText.slice(0, 300)}`);
        return;
    }

    const data = await res.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
    const usage = data.usageMetadata;

    console.log(`\n--- ${model} (${elapsed}ms) ---`);
    console.log(`Response: ${text.trim()}`);
    if (usage) {
        console.log(`Tokens: in=${usage.promptTokenCount} out=${usage.candidatesTokenCount} total=${usage.totalTokenCount}`);
    }
}

async function listModels(): Promise<void> {
    const res = await fetch(`${BASE_URL}/models?key=${GEMINI_API_KEY}`);
    if (!res.ok) {
        console.error(`List models failed: ${res.status}`);
        return;
    }
    const data = await res.json() as any;
    const models = (data.models ?? [])
        .map((m: any) => m.name?.replace('models/', ''))
        .filter((n: string) => n?.startsWith('gemini-'))
        .sort();
    console.log('Available Gemini models:');
    models.forEach((m: string) => console.log(`  - ${m}`));
}

async function main() {
    console.log('=== Gemini API Test ===\n');

    await listModels();

    for (const model of MODELS_TO_TEST) {
        await testModel(model);
    }

    console.log('\nDone.');
}

main().catch(console.error);
