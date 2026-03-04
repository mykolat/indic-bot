import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
  openaiCodexOAuthProvider,
  type OAuthCredentials,
} from '@mariozechner/pi-ai';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';

const TOKEN_FILE = join(process.env.HOME || '.', '.indic-bot', 'oauth-credentials.json');

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

function loadStoredCredentials(): OAuthCredentials | null {
  try {
    const data = readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(data) as OAuthCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(creds: OAuthCredentials): void {
  mkdirSync(join(process.env.HOME || '.', '.indic-bot'), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(creds, null, 2), 'utf-8');
}

export async function getOpenAIAccessToken(): Promise<string> {
  // 1. Try to load stored credentials
  let creds = loadStoredCredentials();

  if (creds) {
    // 2. Check if token is still valid (with 60s buffer)
    const nowSec = Math.floor(Date.now() / 1000);
    if (creds.expires > nowSec + 60) {
      return openaiCodexOAuthProvider.getApiKey(creds);
    }

    // 3. Token expired — try to refresh
    console.log('[OAuth] Token expired, refreshing...');
    try {
      creds = await refreshOpenAICodexToken(creds.refresh);
      saveCredentials(creds);
      console.log('[OAuth] Token refreshed successfully');
      return openaiCodexOAuthProvider.getApiKey(creds);
    } catch (err) {
      console.error('[OAuth] Refresh failed, need re-login:', err);
    }
  }

  // 4. No valid token — run interactive OAuth flow
  console.log('[OAuth] Starting OpenAI login flow...');
  console.log('[OAuth] A browser window will open for authentication.\n');

  creds = await loginOpenAICodex({
    onAuth: ({ url, instructions }) => {
      if (instructions) console.log(instructions);
      console.log(`[OAuth] Open this URL if browser doesn't open:\n${url}\n`);
      openInBrowser(url);
    },
    onPrompt: async (prompt) => {
      // For manual code paste (VPS/remote environments)
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<string>((resolve) => {
        rl.question(`${prompt.message}: `, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
    onProgress: (msg) => console.log(`[OAuth] ${msg}`),
  });

  saveCredentials(creds);
  console.log('[OAuth] Login successful! Token stored.\n');
  return openaiCodexOAuthProvider.getApiKey(creds);
}
