// Claim filing deadline.
export const FILING_WINDOW_DAYS = 30;

export function isLate(ageDays: number): boolean {
  return ageDays > FILING_WINDOW_DAYS;
}
