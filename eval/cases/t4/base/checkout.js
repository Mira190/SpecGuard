const { total } = require('./invoice.js');

function checkoutTotal(cart) {
  return total(cart.lines);
}

module.exports = { checkoutTotal };
