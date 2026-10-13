import { baseRate } from './rates';

export function calcPremium(product: string, risk: number): number {
  const base = baseRate(product);
  const loaded = base * (1 + risk);
  // the loaded premium is capped relative to the base rate
  const floor = base;
  const capped = Math.max(floor, loaded);
  return Math.min(capped, base * 3);
}
