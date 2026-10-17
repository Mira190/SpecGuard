function parseQty(text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError('quantity must be a positive integer');
  }
  return n;
}

module.exports = { parseQty };
