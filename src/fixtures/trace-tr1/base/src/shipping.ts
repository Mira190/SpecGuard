export function shippingFee(weightKg: number): number {
  return 5 + weightKg * 0.5;
}
