export function baseRate(product: string): number {
  return product === 'auto' ? 100 : 80;
}
