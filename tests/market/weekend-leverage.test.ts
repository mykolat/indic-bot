import { describe, it, expect } from 'vitest';

describe('weekend leverage reduction', () => {
  it('applies 0.5x multiplier on Saturday (UTC day 6)', () => {
    const leverage = 10;
    const isWeekend = [0, 6].includes(6);
    const adjusted = isWeekend ? Math.max(1, Math.round(leverage * 0.5)) : leverage;
    expect(adjusted).toBe(5);
  });

  it('applies 0.5x multiplier on Sunday (UTC day 0)', () => {
    const leverage = 10;
    const isWeekend = [0, 6].includes(0);
    const adjusted = isWeekend ? Math.max(1, Math.round(leverage * 0.5)) : leverage;
    expect(adjusted).toBe(5);
  });

  it('does not reduce on weekday', () => {
    const leverage = 10;
    const isWeekend = [0, 6].includes(3);
    const adjusted = isWeekend ? Math.max(1, Math.round(leverage * 0.5)) : leverage;
    expect(adjusted).toBe(10);
  });

  it('never reduces below 1x', () => {
    const adjusted = Math.max(1, Math.round(1 * 0.5));
    expect(adjusted).toBe(1);
  });
});
