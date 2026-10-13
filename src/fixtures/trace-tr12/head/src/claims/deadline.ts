// Claim filing deadline.
export const FILING_WINDOW_DAYS = 45;

export function isLate(ageDays: number): boolean {
  return ageDays > FILING_WINDOW_DAYS;
}
