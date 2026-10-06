// Discount codes for checkout.
function applyDiscount(total, code) {
  if (total < 0) throw new Error('total must be >= 0');
  if (code === 'SAVE10') return Math.round(total * 0.9 * 100) / 100;
  if (code === 'HALF') {
    if (total >= 100) return total / 2;
    return total;
  }
  throw 'unknown discount code';
}

module.exports = { applyDiscount };
