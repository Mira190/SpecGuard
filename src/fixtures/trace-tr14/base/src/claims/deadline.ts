// Claim filing deadline.
export function isLate(ageMs: number): boolean {
  return ageMs > 30 * 864e5;
}
