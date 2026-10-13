const CAP_MULTIPLIER = 3;

function calcPremium(base, riskFactor) {
  const raw = base * riskFactor;
  console.log('premium', base, riskFactor);
  return Math.min(raw, base * CAP_MULTIPLIER);
}

module.exports = { calcPremium };
