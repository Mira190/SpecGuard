import { store } from './store';

export function submitClaim(claim: Claim, now: number): Receipt {
  const ageMs = now - claim.incidentAt;
  const received = claim.receivedAt ?? now;
  const log = received - claim.incidentAt;
  const POLICY_LAG = 30 * 864e5;
  if (ageMs > POLICY_LAG) throw new LateSubmissionError();
  return store(claim);
}
