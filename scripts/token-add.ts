import { createInterface } from 'readline';
import { initPool, closePool } from '../src/db/connection.js';
import { insertToken } from '../src/db/repository.js';
import { loadConfig } from '../src/config.js';
import { getOpenAIAccessToken } from '../src/llm/oauth.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const NATO = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel',
  'india','juliet','kilo','lima','mike','november','oscar','papa','quebec',
  'romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu'];

function randomLabel(): string {
  return NATO[Math.floor(Math.random() * NATO.length)];
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  const config = loadConfig();
  if (!config.database.url) {
    console.error('DATABASE_URL required. Set it in .env');
    process.exit(1);
  }
  initPool(config.database.url);

  const providerArg = process.argv[2];
  const provider = providerArg || await ask('Provider (codex/openai/xai/google): ');

  const oauthProviders = ['codex'];
  const authType = oauthProviders.includes(provider) ? 'oauth' : 'api';
  const label = randomLabel();

  if (authType === 'oauth') {
    console.log(`\nStarting OAuth flow for '${provider}'...\n`);
    const accessToken = await getOpenAIAccessToken();

    // Read the stored credentials to get refresh token + account_id
    const credsPath = join(process.env.HOME || '.', '.indic-bot', 'oauth-credentials.json');
    const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));

    const id = await insertToken({
      label,
      provider,
      auth_type: 'oauth',
      access_token: creds.access,
      refresh_token: creds.refresh,
      account_id: creds.accountId,
      expires_at: new Date(creds.expires * 1000).toISOString(),
      is_active: true,
    });

    console.log(`\nToken '${label}' (${provider}/oauth) added — id=${id}, account=${creds.accountId.slice(0, 8)}...`);
  } else {
    const apiKey = await ask(`API key for ${provider}: `);
    const id = await insertToken({
      label,
      provider,
      auth_type: 'api',
      api_key: apiKey,
      is_active: true,
    });
    console.log(`\nToken '${label}' (${provider}/api) added — id=${id}`);
  }

  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
