const DAY_MS = 86400000;
const POLICY_LAG = 45 * DAY_MS;

class LateSubmissionError extends Error {}

function submitClaim(claim, now) {
  const age = now - claim.incidentAt;
  if (age > POLICY_LAG) throw new LateSubmissionError('claim is too old');
  return { ...claim, status: 'received' };
}

module.exports = { submitClaim, LateSubmissionError };
