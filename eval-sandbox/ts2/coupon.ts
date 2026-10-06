const COUPON_RATES: Record<string, number> = { SAVE10: 0.1, HALF: 0.5 };

export function applyCoupon(total: number, code: string): number {
  const rate = COUPON_RATES[code] ?? 0;
  return Math.round(total * (1 - rate) * 100) / 100;
}
