const RATE = 1.2;

function addTax(amount) {
  if (amount < 0) {
    throw new RangeError('amount must not be negative');
  }
  return Math.round(amount * RATE * 100) / 100;
}

module.exports = { addTax };
