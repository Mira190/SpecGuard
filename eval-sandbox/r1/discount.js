const subtotal = (items) => items.reduce((sum, i) => sum + i.price * i.qty, 0);

function applyDiscount(order) {
  if (order.items.length === 0) {
    throw new Error('empty order');
  }
  let total = subtotal(order.items);
  if (order.coupon === 'SAVE10') {
    total *= 0.9;
  }
  if (total >= 100) {
    total -= 5;
  }
  return Math.max(total - (order.credit || 0), 0);
}

module.exports = { applyDiscount };
