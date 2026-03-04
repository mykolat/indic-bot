import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrokGrounder } from '../../src/news/grok-grounder.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

describe('GrokGrounder', () => {
  let grounder: GrokGrounder;

  beforeEach(() => {
    vi.clearAllMocks();
    grounder = new GrokGrounder('test-xai-key');
  });

  it('verifies a claim via xAI API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              verified: true,
              confidence: 0.95,
              summary: 'Confirmed by @SECGov and @Bloomberg.',
              sources: ['@SECGov', '@Bloomberg'],
              contradictions: [],
            }),
          },
        }],
        usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      }),
    } as any);

    const result = await grounder.verify('SEC approves spot BTC ETF');

    expect(result.claim).toBe('SEC approves spot BTC ETF');
    expect(result.verified).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.summary).toContain('Confirmed');
    expect(result.tokensUsed).toBe(300);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe('grok-3');
    expect((opts!.headers as any)['Authorization']).toBe('Bearer test-xai-key');
  });

  it('returns unverified result on API failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const result = await grounder.verify('Some claim');

    expect(result.claim).toBe('Some claim');
    expect(result.verified).toBeUndefined();
    expect(result.error).toBe('timeout');
    expect(result.tokensUsed).toBe(0);
  });

  it('returns unverified on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as any);

    const result = await grounder.verify('Some claim');
    expect(result.error).toContain('401');
  });

  it('handles malformed JSON in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Not valid JSON at all' } }],
        usage: { total_tokens: 50 },
      }),
    } as any);

    const result = await grounder.verify('Claim');
    expect(result.claim).toBe('Claim');
    expect(result.summary).toBeDefined();
    expect(result.tokensUsed).toBe(50);
  });
});
