import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrokGrounder } from '../../src/news/grok-grounder.js';
import type { GroundingResult } from '../../src/news/grok-grounder.js';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';
const mockFetch = vi.mocked(fetchWithTimeout);

function mockResponsesApi(content: string, inputTokens = 200, outputTokens = 100) {
  return {
    ok: true,
    json: async () => ({
      output_text: content,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  } as any;
}

describe('GrokGrounder', () => {
  let grounder: GrokGrounder;

  beforeEach(() => {
    vi.clearAllMocks();
    grounder = new GrokGrounder('test-xai-key');
  });

  it('verifies a claim via xAI Responses API', async () => {
    mockFetch.mockResolvedValueOnce(mockResponsesApi(
      JSON.stringify({
        verified: true,
        confidence: 0.95,
        summary: 'Confirmed by @SECGov and @Bloomberg.',
        sources: ['@SECGov', '@Bloomberg'],
        contradictions: [],
      }),
      200, 100,
    ));

    const result = await grounder.verify('SEC approves spot BTC ETF');

    expect(result.claim).toBe('SEC approves spot BTC ETF');
    expect(result.verified).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.summary).toContain('Confirmed');
    expect(result.tokensUsed).toBe(300);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/responses');
    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe('grok-4-1-fast-non-reasoning');
    expect(body.tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }]);
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
    mockFetch.mockResolvedValueOnce(mockResponsesApi('Not valid JSON at all', 30, 20));

    const result = await grounder.verify('Claim');
    expect(result.claim).toBe('Claim');
    expect(result.summary).toBeDefined();
    expect(result.tokensUsed).toBe(50);
  });

  it('handles output array fallback when output_text is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ text: '{"verified": true, "confidence": 0.8, "summary": "ok"}' }] }],
        usage: { input_tokens: 50, output_tokens: 50 },
      }),
    } as any);

    const result = await grounder.verify('test');
    expect(result.verified).toBe(true);
    expect(result.tokensUsed).toBe(100);
  });

  it('records success in sourceHealth on verify', async () => {
    mockFetch.mockResolvedValueOnce(mockResponsesApi(
      '{"verified": true, "confidence": 0.9, "summary": "confirmed"}',
      50, 50,
    ));
    const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    const g = new GrokGrounder('key', mockHealth as any);
    await g.verify('test claim');
    expect(mockHealth.recordSuccess).toHaveBeenCalledWith('grok-grounder');
  });

  it('records failure in sourceHealth on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as any);
    const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    const g = new GrokGrounder('key', mockHealth as any);
    await g.verify('test claim');
    expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-grounder', expect.stringContaining('500'));
  });

  it('retries without tools on 410 Gone and returns grounding result', async () => {
    // First call returns 410
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 410,
      text: async () => 'Gone',
    } as any);
    // Second call (retry without tools) succeeds
    mockFetch.mockResolvedValueOnce(mockResponsesApi(
      JSON.stringify({
        verified: null,
        confidence: 0.5,
        summary: 'Cannot verify without search — based on model knowledge',
        sources: [],
        contradictions: [],
      }),
      100, 100,
    ));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await grounder.verify('Some crypto claim');

    expect(result.claim).toBe('Some crypto claim');
    expect(result.verified).toBeNull();
    expect(result.confidence).toBe(0.5);
    expect(result.tokensUsed).toBe(200);
    expect(result.error).toBeUndefined();

    // Verify retry was made without tools
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1]!.body as string);
    expect(retryBody.tools).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('410 Gone'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('model knowledge only'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('extracts enriched fields (claimType, tradability, sourceQuality)', async () => {
    mockFetch.mockResolvedValueOnce(mockResponsesApi(
      JSON.stringify({
        verified: true,
        confidence: 0.9,
        summary: 'SEC filing confirmed',
        sources: ['@SECGov'],
        contradictions: [],
        claim_type: 'regulatory',
        tradability: 'actionable',
        source_quality: 'official',
      }),
      200, 200,
    ));

    const result = await grounder.verify('SEC approves new crypto rule');
    expect(result.claimType).toBe('regulatory');
    expect(result.tradability).toBe('actionable');
    expect(result.sourceQuality).toBe('official');
  });
});

describe('GroundingResult type', () => {
  it('accepts enriched fields', () => {
    const result: GroundingResult = {
      claim: 'BTC to 200k',
      verified: null,
      confidence: 0.3,
      summary: 'Unverified prediction',
      sources: ['@crypto_guru'],
      contradictions: [],
      tokensUsed: 500,
      claimType: 'prediction',
      tradability: 'none',
      sourceQuality: 'influencer',
    };
    expect(result.claimType).toBe('prediction');
    expect(result.tradability).toBe('none');
    expect(result.sourceQuality).toBe('influencer');
  });

  it('works without enriched fields (backward compat)', () => {
    const result: GroundingResult = {
      claim: 'test',
      tokensUsed: 0,
    };
    expect(result.claimType).toBeUndefined();
  });
});
