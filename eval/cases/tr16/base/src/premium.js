const CAP_MULTIPLIER = 2;

function calcPremium(base, riskFactor) {
  const raw = base * riskFactor;
  return Math.min(raw, base * CAP_MULTIPLIER);
}

module.exports = { calcPremium };
