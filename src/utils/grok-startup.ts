import type { GrokClient } from '../llm/grok-client.js';

export async function runGrokHealthCheck(client: GrokClient): Promise<boolean> {
  try {
    const result = await client.healthCheck();
    if (result.ok) {
      console.log('[Grok] Health check PASSED — xAI API key is valid');
      return true;
    }
    console.error('[Grok] Health check FAILED', result.error ?? 'unknown');
    return false;
  } catch (err: any) {
    console.error('[Grok] Health check FAILED', err?.message ?? 'unknown');
    return false;
  }
}
