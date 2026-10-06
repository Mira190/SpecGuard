import { describe, expect, it } from 'vitest';
import { applyCoupon } from './coupon';

describe('applyCoupon', () => {
  it('returns a result for SAVE10', () => {
    expect(applyCoupon(100, 'SAVE10')).toBeDefined();
  });

  it('returns a number', () => {
    expect(applyCoupon(100, 'SAVE10')).toBeTypeOf('number');
  });
});
