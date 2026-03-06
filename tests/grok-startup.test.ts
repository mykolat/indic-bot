import { describe, it, expect, vi } from 'vitest';
import { runGrokHealthCheck } from '../src/utils/grok-startup.js';

describe('runGrokHealthCheck', () => {
  it('logs success when healthCheck passes', async () => {
    const mockClient = { healthCheck: vi.fn().mockResolvedValue({ ok: true }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runGrokHealthCheck(mockClient as any);
    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check PASSED'));
    logSpy.mockRestore();
  });

  it('logs error when healthCheck fails', async () => {
    const mockClient = { healthCheck: vi.fn().mockResolvedValue({ ok: false, error: '401 Unauthorized' }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runGrokHealthCheck(mockClient as any);
    expect(result).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check FAILED'), expect.stringContaining('401'));
    errSpy.mockRestore();
  });

  it('logs error when healthCheck throws', async () => {
    const mockClient = { healthCheck: vi.fn().mockRejectedValue(new Error('network down')) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runGrokHealthCheck(mockClient as any);
    expect(result).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check FAILED'), expect.stringContaining('network down'));
    errSpy.mockRestore();
  });
});
