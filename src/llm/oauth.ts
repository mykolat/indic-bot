import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

const TOKEN_FILE = join(process.env.HOME || '.', '.indic-bot', 'oauth-credentials.json');

interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
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

function base64urlEncode(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString('base64url');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function decodeJwt(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

async function exchangeCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as any;
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Token response missing required fields');
  }

  const accountId = getAccountId(json.access_token);
  if (!accountId) throw new Error('Failed to extract accountId from token');

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
    accountId,
  };
}

async function refreshToken(refreshTokenStr: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenStr,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const json = (await response.json()) as any;
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Token refresh response missing fields');
  }

  const accountId = getAccountId(json.access_token);
  if (!accountId) throw new Error('Failed to extract accountId from refreshed token');

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
    accountId,
  };
}

function startCallbackServer(state: string): Promise<{
  close: () => void;
  waitForCode: () => Promise<string | null>;
}> {
  return new Promise((resolve) => {
    let receivedCode: string | null = null;

    const server = createServer((req, res) => {
      const url = new URL(req.url || '', 'http://localhost');
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.statusCode = 400;
        res.end('State mismatch');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end('Missing code');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><p>Authentication successful. Return to your terminal.</p></body></html>');
      receivedCode = code;
    });

    server.listen(1455, '127.0.0.1', () => {
      resolve({
        close: () => server.close(),
        waitForCode: async () => {
          for (let i = 0; i < 600; i++) {
            if (receivedCode) return receivedCode;
            await new Promise((r) => setTimeout(r, 100));
          }
          return null;
        },
      });
    });

    server.on('error', () => {
      resolve({
        close: () => { try { server.close(); } catch {} },
        waitForCode: async () => null,
      });
    });
  });
}

async function interactiveLogin(): Promise<OAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString('hex');

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');

  const server = await startCallbackServer(state);

  console.log('[OAuth] Open this URL to login:\n');
  console.log(url.toString());
  console.log();

  try {
    const code = await server.waitForCode();
    if (!code) {
      // Fallback: ask user to paste
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const input = await new Promise<string>((resolve) => {
        rl.question('[OAuth] Paste the redirect URL or authorization code: ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      // Extract code from URL or use as-is
      try {
        const parsed = new URL(input);
        const extractedCode = parsed.searchParams.get('code');
        if (extractedCode) return exchangeCode(extractedCode, verifier);
      } catch {}
      return exchangeCode(input, verifier);
    }
    return exchangeCode(code, verifier);
  } finally {
    server.close();
  }
}

export async function getOpenAIAccessToken(): Promise<string> {
  // 1. Try to load stored credentials
  let creds = loadStoredCredentials();

  if (creds) {
    // 2. Check if token is still valid (with 60s buffer)
    const nowSec = Math.floor(Date.now() / 1000);
    if (creds.expires > nowSec + 60) {
      return creds.access;
    }

    // 3. Token expired — try to refresh
    console.log('[OAuth] Token expired, refreshing...');
    try {
      creds = await refreshToken(creds.refresh);
      saveCredentials(creds);
      console.log('[OAuth] Token refreshed successfully');
      return creds.access;
    } catch (err) {
      console.error('[OAuth] Refresh failed, need re-login:', err);
    }
  }

  // 4. No valid token — run interactive OAuth flow
  console.log('[OAuth] Starting OpenAI login flow...');
  creds = await interactiveLogin();
  saveCredentials(creds);
  console.log('[OAuth] Login successful! Token stored.\n');
  return creds.access;
}
