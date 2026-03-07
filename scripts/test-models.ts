/**
 * Quick test: hit Codex API with OAuth token for gpt-5.3-codex, then try gpt-5.4
 * Usage: npx tsx scripts/test-models.ts
 */
import os from 'node:os';
import { readFileSync } from 'fs';
import { join } from 'path';

const TOKEN_FILE = join(process.env.HOME || '.', '.indic-bot', 'oauth-credentials.json');
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const JWT_CLAIM = 'https://api.openai.com/auth';

// Also try standard OpenAI Responses API
const OPENAI_URL = 'https://api.openai.com/v1/responses';

function loadToken(): { access: string; accountId: string } {
  const creds = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  const payload = JSON.parse(Buffer.from(creds.access.split('.')[1], 'base64').toString());
  const accountId = payload?.[JWT_CLAIM]?.chatgpt_account_id;
  console.log(`Token loaded, accountId: ${accountId}`);
  console.log(`Token expires: ${new Date(creds.expires * 1000).toISOString()}`);
  const nowSec = Math.floor(Date.now() / 1000);
  if (creds.expires < nowSec) {
    console.warn('⚠️  Token is EXPIRED! Run the bot first to refresh.\n');
  }
  return { access: creds.access, accountId };
}

async function callCodexAPI(token: string, accountId: string, model: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${model} via Codex SSE API`);
  console.log(`URL: ${CODEX_URL}`);
  console.log(`${'='.repeat(60)}\n`);

  const body = {
    model,
    store: false,
    stream: true,
    instructions: 'You are a helpful assistant. Be very brief.',
    input: [{ role: 'user', content: `Say "Hello from ${model}!" and nothing else.` }],
    text: { verbosity: 'low' },
  };

  const start = Date.now();
  try {
    const res = await fetch(CODEX_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        'User-Agent': `indic-test (${os.platform()})`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    const elapsed = Date.now() - start;
    console.log(`Status: ${res.status} ${res.statusText} (${elapsed}ms)`);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`Error: ${err.slice(0, 500)}`);
      return;
    }

    // Parse SSE stream
    const text = await res.text();
    let output = '';
    let actualModel = '';
    let usage = { input_tokens: 0, output_tokens: 0 };

    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        if (evt.type === 'response.output_text.delta' && evt.delta) {
          output += evt.delta;
        }
        if (evt.type === 'response.completed' && evt.response) {
          actualModel = evt.response.model || '';
          if (evt.response.usage) usage = evt.response.usage;
          // fallback text extraction
          if (!output) {
            for (const item of evt.response.output || []) {
              if (item.type === 'message') {
                for (const block of item.content || []) {
                  if (block.type === 'output_text') output = block.text;
                }
              }
            }
          }
        }
      } catch {}
    }

    console.log(`Model responded: ${output || '(no text output)'}`);
    if (actualModel) console.log(`Actual model: ${actualModel}`);
    if (usage.input_tokens) console.log(`Tokens: in=${usage.input_tokens}, out=${usage.output_tokens}`);
    console.log('✅ SUCCESS\n');
  } catch (err: any) {
    console.error(`❌ FAILED: ${err.message}\n`);
  }
}

async function callOpenAIAPI(token: string, accountId: string, model: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${model} via OpenAI Responses API`);
  console.log(`URL: ${OPENAI_URL}`);
  console.log(`${'='.repeat(60)}\n`);

  const body = {
    model,
    store: false,
    instructions: 'You are a helpful assistant. Be very brief.',
    input: [{ role: 'user', content: `Say "Hello from ${model}!" and nothing else.` }],
  };

  const start = Date.now();
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const elapsed = Date.now() - start;
    console.log(`Status: ${res.status} ${res.statusText} (${elapsed}ms)`);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`Error: ${err.slice(0, 500)}`);
      return;
    }

    const data = await res.json() as any;
    const output = data.output
      ?.filter((o: any) => o.type === 'message')
      ?.flatMap((o: any) => o.content)
      ?.filter((c: any) => c.type === 'output_text')
      ?.map((c: any) => c.text)
      ?.join('');

    console.log(`Model responded: ${output || '(no text output)'}`);
    if (data.usage) {
      console.log(`Tokens: in=${data.usage.input_tokens}, out=${data.usage.output_tokens}`);
    }
    if (data.model) {
      console.log(`Actual model: ${data.model}`);
    }
    console.log('✅ SUCCESS\n');
  } catch (err: any) {
    console.error(`❌ FAILED: ${err.message}\n`);
  }
}

async function main() {
  const { access, accountId } = loadToken();

  // 1. Current model — Codex API
  await callCodexAPI(access, accountId, 'gpt-5.3-codex');

  // 2. Try GPT-5.4 variants — Codex API
  const candidates = [
    'gpt-5.4',
    'gpt-5.4-codex',
  ];

  for (const model of candidates) {
    await callCodexAPI(access, accountId, model);
  }

  console.log('Done. OpenAI Responses API skipped (OAuth token lacks api.responses.write scope).');
}

main().catch(console.error);
