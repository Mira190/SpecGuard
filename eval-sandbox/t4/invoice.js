function total(lines) {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}

module.exports = { total };
