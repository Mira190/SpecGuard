const FREE_SHIPPING_FROM = 800;
const FLAT_RATE = 12;

function shippingCost(order) {
  if (!order || typeof order.subtotal !== 'number') {
    throw new Error('shipping cost needs an order with a numeric subtotal');
  }
  if (order.subtotal >= FREE_SHIPPING_FROM) return 0;
  return FLAT_RATE;
}

module.exports = { shippingCost };
