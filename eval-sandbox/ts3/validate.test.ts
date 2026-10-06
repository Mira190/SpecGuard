import { describe, expect, it } from 'vitest';
import { validateAge } from './validate';

describe('validateAge', () => {
  it('returns valid ages unchanged, including both bounds', () => {
    expect(validateAge(0)).toBe(0);
    expect(validateAge(30)).toBe(30);
    expect(validateAge(150)).toBe(150);
  });

  it('rejects ages outside 0..150', () => {
    expect(() => validateAge(-1)).toThrow(RangeError);
    expect(() => validateAge(151)).toThrow(RangeError);
  });

  it('rejects non-integers', () => {
    expect(() => validateAge(1.5)).toThrow('Invalid age: 1.5');
    expect(() => validateAge(Number.NaN)).toThrow('Invalid age: NaN');
  });
});
