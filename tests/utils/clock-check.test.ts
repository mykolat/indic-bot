import { describe, it, expect, vi } from 'vitest';
import { checkClockSkew, warnIfClockSkewed } from '../../src/utils/clock-check.js';

describe('checkClockSkew', () => {
  it('returns skew in milliseconds', async () => {
    const skew = await checkClockSkew();
    expect(typeof skew).toBe('number');
  });
});

describe('warnIfClockSkewed', () => {
  it('logs OK when skew is small', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await warnIfClockSkewed(999999); // very high threshold
    // Should log OK (not error) since skew is likely < 999999ms
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[Clock]'));
    spy.mockRestore();
    errSpy.mockRestore();
  });
});
